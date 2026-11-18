import type { FastifyBaseLogger } from "fastify";

/**
 * Outgoing email and SMS. Each method resolves once the provider has accepted
 * the message and throws otherwise, so the outbox worker can retry it.
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
   * (a worker that crashed after sending but before recording it).
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
    if (!res.ok) {
      throw new NotifierError(
        `Resend refused the email (${await describe(res)})`,
      );
    }
  };
};

/**
 * Africa's Talking `POST /version1/messaging`. The username `sandbox` goes to
 * the sandbox API, which delivers to the simulator instead of real phones.
 */
export const africasTalkingSms = ({
  username,
  apiKey,
  senderId,
  baseUrl = username === "sandbox"
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com",
}: {
  username: string;
  apiKey: string;
  senderId?: string;
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
      throw new NotifierError(
        `Africa's Talking refused the SMS (${await describe(res)})`,
      );
    }
    // A 201 can still carry a per-recipient failure (bad number, no credit).
    // 100 Processed, 101 Sent and 102 Queued are the accepted codes.
    const body = (await res.json().catch(() => null)) as {
      SMSMessageData?: {
        Recipients?: { statusCode?: number; status?: string }[];
      };
    } | null;
    const recipient = body?.SMSMessageData?.Recipients?.[0];
    if (
      !recipient?.statusCode ||
      ![100, 101, 102].includes(recipient.statusCode)
    ) {
      throw new NotifierError(
        `Africa's Talking didn't accept the SMS: ${recipient?.status ?? "no recipient in response"}`,
      );
    }
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
 *   - in production, throws, so its messages stay queued and the worker
 *     retries them and then gives up loudly. Nothing is marked sent that
 *     wasn't.
 */
export const createNotifier = (
  config: NotifierConfig,
  log: FastifyBaseLogger,
): Notifier => {
  const missing = (channel: string) => async (message: unknown) => {
    if (config.NODE_ENV === "production") {
      throw new NotifierError(`No ${channel} provider is configured`);
    }
    log.info({ channel, message }, `${channel} not configured; logged instead`);
  };

  const email = config.RESEND_API_KEY
    ? resendEmail({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM })
    : missing("email");
  const sms =
    config.AFRICASTALKING_USERNAME && config.AFRICASTALKING_API_KEY
      ? africasTalkingSms({
          username: config.AFRICASTALKING_USERNAME,
          apiKey: config.AFRICASTALKING_API_KEY,
          senderId: config.AFRICASTALKING_SENDER_ID,
        })
      : missing("SMS");

  if (config.NODE_ENV === "production") {
    if (!config.RESEND_API_KEY) {
      log.warn("RESEND_API_KEY is not set: confirmation emails can't be sent");
    }
    if (!config.AFRICASTALKING_API_KEY) {
      log.warn(
        "AFRICASTALKING_API_KEY is not set: confirmation SMS can't be sent",
      );
    }
  }
  return { email, sms };
};
