import type { FastifyBaseLogger } from "fastify";

/**
 * Outgoing email and SMS. Each method resolves once the provider has accepted
 * the message and throws otherwise. What it throws tells the outbox worker
 * what to do next:
 *   - `NotifierError`: may work later (an outage, a rate limit, a bad API
 *     key someone will fix). Retried with backoff.
 *   - `PermanentNotifierError`: this message will never be accepted (an
 *     invalid address or number). Abandoned at once.
 *   - `NotConfiguredError`: no provider for the channel yet. Kept queued
 *     without using up an attempt.
 */
export interface Notifier {
  email(message: EmailMessage): Promise<void>;
  sms(message: SmsMessage): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /**
   * Same key, same email: the provider sends it once even if we ask twice
   * (a worker that crashed after sending but before recording it). Must be
   * unique across environments that share an API key.
   */
  idempotencyKey: string;
}

export interface SmsMessage {
  /** 2547XXXXXXXX / 2541XXXXXXXX */
  to: string;
  message: string;
}

export class NotifierError extends Error {
  override name = "NotifierError";
}

export class PermanentNotifierError extends NotifierError {
  override name = "PermanentNotifierError";
}

export class NotConfiguredError extends NotifierError {
  override name = "NotConfiguredError";
}

const TIMEOUT_MS = 10_000;

const describe = async (res: Response) =>
  `${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;

/** Resend (https://resend.com) `POST /emails`. */
export const resendEmail = ({
  apiKey,
  from,
  baseUrl = "https://api.resend.com",
}: {
  apiKey: string;
  from: string;
  baseUrl?: string;
}): Notifier["email"] => {
  const url = `${baseUrl.replace(/\/+$/, "")}/emails`;
  return async ({ to, subject, text, idempotencyKey }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return;
    const message = `Resend refused the email (${await describe(res)})`;
    // 400/422: this email is invalid (bad address, bad sender) and always
    // will be. 401/403 (a bad key), 429 and 5xx can be fixed or wait out.
    if (res.status === 400 || res.status === 422) {
      throw new PermanentNotifierError(message);
    }
    throw new NotifierError(message);
  };
};

/** Africa's Talking per-recipient codes. */
const AT_ACCEPTED = new Set([100, 101, 102]); // Processed, Sent, Queued
const AT_PERMANENT = new Set([403, 404, 406]); // InvalidPhoneNumber, UnsupportedNumberType, UserInBlacklist

/**
 * Africa's Talking `POST /version1/messaging`. The username `sandbox` goes to
 * the sandbox API, which delivers to the simulator instead of real phones.
 */
export const africasTalkingSms = ({
  username,
  apiKey,
  senderId,
  log,
  baseUrl = username === "sandbox"
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com",
}: {
  username: string;
  apiKey: string;
  senderId?: string | undefined;
  log?: FastifyBaseLogger | undefined;
  baseUrl?: string;
}): Notifier["sms"] => {
  const url = `${baseUrl.replace(/\/+$/, "")}/version1/messaging`;
  return async ({ to, message }) => {
    const form = new URLSearchParams({ username, to: `+${to}`, message });
    if (senderId) form.set("from", senderId);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apiKey,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const error = `Africa's Talking refused the SMS (${await describe(res)})`;
      if (res.status === 400) throw new PermanentNotifierError(error);
      throw new NotifierError(error);
    }

    // A 2xx means the SMS was taken. The body can still report a
    // per-recipient failure, and only an explicit failure code is acted on:
    // an unreadable body after a 2xx is treated as sent, because retrying a
    // message that probably went out would text the customer again (there's
    // no idempotency key to stop it).
    const body = (await res.json().catch(() => null)) as {
      SMSMessageData?: {
        Recipients?: { statusCode?: unknown; status?: unknown }[];
      };
    } | null;
    const recipient = body?.SMSMessageData?.Recipients?.[0];
    if (typeof recipient?.statusCode !== "number") {
      log?.warn(
        { status: res.status },
        "Africa's Talking accepted the SMS but its response couldn't be read; treating it as sent",
      );
      return;
    }
    if (AT_ACCEPTED.has(recipient.statusCode)) return;
    const error = `Africa's Talking didn't accept the SMS: ${String(recipient.status)} (${recipient.statusCode})`;
    if (AT_PERMANENT.has(recipient.statusCode)) {
      throw new PermanentNotifierError(error);
    }
    throw new NotifierError(error);
  };
};

export interface NotifierConfig {
  NODE_ENV: "development" | "test" | "production";
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM: string;
  AFRICASTALKING_USERNAME?: string | undefined;
  AFRICASTALKING_API_KEY?: string | undefined;
  AFRICASTALKING_SENDER_ID?: string | undefined;
}

/**
 * Builds the notifier from config. A channel without credentials:
 *   - in development and test, logs the message instead of sending it;
 *   - in production, throws `NotConfiguredError`: its messages stay queued,
 *     without using up attempts, and go out once credentials are set.
 *     Nothing is marked sent that wasn't.
 */
export const createNotifier = (
  config: NotifierConfig,
  log: FastifyBaseLogger,
): Notifier => {
  const missing = (channel: string) => async (message: unknown) => {
    if (config.NODE_ENV === "production") {
      throw new NotConfiguredError(`No ${channel} provider is configured`);
    }
    log.info({ channel, message }, `${channel} not configured; logged instead`);
  };

  const emailReady = Boolean(config.RESEND_API_KEY);
  const smsReady = Boolean(
    config.AFRICASTALKING_USERNAME && config.AFRICASTALKING_API_KEY,
  );

  const email = config.RESEND_API_KEY
    ? resendEmail({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM })
    : missing("email");
  const sms =
    config.AFRICASTALKING_USERNAME && config.AFRICASTALKING_API_KEY
      ? africasTalkingSms({
          username: config.AFRICASTALKING_USERNAME,
          apiKey: config.AFRICASTALKING_API_KEY,
          senderId: config.AFRICASTALKING_SENDER_ID,
          log,
        })
      : missing("SMS");

  if (config.NODE_ENV === "production") {
    if (!emailReady) {
      log.warn(
        "RESEND_API_KEY is not set: confirmation emails will wait in the outbox",
      );
    }
    if (!smsReady) {
      log.warn(
        "AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY must both be set: confirmation SMS will wait in the outbox",
      );
    }
  }
  return { email, sms };
};
