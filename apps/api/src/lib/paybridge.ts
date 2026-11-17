import { z } from "zod";

/**
 * Client for PayBridge v1, which sends M-Pesa STK pushes for us.
 *
 * Only the fields Soko relies on are validated; PayBridge may add more.
 */

export const PAYBRIDGE_STATUSES = [
  "CREATED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type PayBridgeStatus = (typeof PAYBRIDGE_STATUSES)[number];

export const payBridgePaymentSchema = z.looseObject({
  id: z.string().min(1),
  status: z.enum(PAYBRIDGE_STATUSES),
  amount: z.number().int(),
  result_desc: z.string().nullable().optional(),
});
export type PayBridgePayment = z.infer<typeof payBridgePaymentSchema>;

export interface CreatePaymentInput {
  /** 2547XXXXXXXX / 2541XXXXXXXX */
  phone: string;
  /** Whole KES. */
  amount: number;
  /** Shown to the customer as the account number. At most 12 characters. */
  reference: string;
  /** At most 13 characters. */
  description: string;
}

export type CreatePaymentResult =
  /** 202: the STK push is on its way (or, rarely, already settled). */
  | { kind: "accepted"; payment: PayBridgePayment }
  /** 502: M-Pesa refused the push. The payment exists and is FAILED. */
  | { kind: "rejected"; payment: PayBridgePayment }
  /**
   * 400 or 422: PayBridge will never accept this request as it stands (a bad
   * phone number, or the key reused with another body). Retrying won't help.
   */
  | { kind: "invalid"; status: number; message: string }
  /**
   * Couldn't tell: a timeout, a network error, 409 (key still in progress),
   * 429, 401 or a 5xx. Safe to retry with the same Idempotency-Key: PayBridge
   * never sends a second push for one key.
   */
  | { kind: "unavailable"; reason: string };

export class PayBridgeError extends Error {
  override name = "PayBridgeError";
}

export interface PayBridgeOptions {
  baseUrl: string;
  apiKey: string;
  /** Creating a payment waits on Daraja, so it gets longer. */
  createTimeoutMs?: number;
  getTimeoutMs?: number;
}

const errorMessage = async (res: Response) => {
  const body: unknown = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body
      ? body.message
      : undefined;
  return typeof message === "string" ? message : `HTTP ${res.status}`;
};

export const createPayBridgeClient = ({
  baseUrl,
  apiKey,
  createTimeoutMs = 15_000,
  getTimeoutMs = 3_000,
}: PayBridgeOptions) => {
  const root = baseUrl.replace(/\/+$/, "");

  const call = (path: string, timeoutMs: number, init: RequestInit = {}) =>
    fetch(`${root}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

  /**
   * `POST /v1/payments`. Never throws: every outcome is a result, because the
   * caller has to decide what to do with the order in each case.
   */
  const createPayment = async (
    input: CreatePaymentInput,
    idempotencyKey: string,
  ): Promise<CreatePaymentResult> => {
    let res: Response;
    try {
      res = await call("/v1/payments", createTimeoutMs, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      return {
        kind: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.status === 202 || res.status === 502) {
      const parsed = payBridgePaymentSchema.safeParse(
        await res.json().catch(() => null),
      );
      // A 502 without a payment body came from a proxy, not from PayBridge.
      if (!parsed.success) {
        return {
          kind: "unavailable",
          reason: `Unexpected ${res.status} response body`,
        };
      }
      return {
        kind: res.status === 202 ? "accepted" : "rejected",
        payment: parsed.data,
      };
    }
    if (res.status === 400 || res.status === 422) {
      return {
        kind: "invalid",
        status: res.status,
        message: await errorMessage(res),
      };
    }
    return {
      kind: "unavailable",
      reason: `${res.status}: ${await errorMessage(res)}`,
    };
  };

  /** `GET /v1/payments/:id`. undefined on 404; throws on anything else. */
  const getPayment = async (
    id: string,
  ): Promise<PayBridgePayment | undefined> => {
    const res = await call(
      `/v1/payments/${encodeURIComponent(id)}`,
      getTimeoutMs,
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new PayBridgeError(
        `GET payment ${id} failed: ${res.status} ${await errorMessage(res)}`,
      );
    }
    const parsed = payBridgePaymentSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new PayBridgeError(`GET payment ${id}: unexpected response body`);
    }
    return parsed.data;
  };

  return { createPayment, getPayment };
};

export type PayBridgeClient = ReturnType<typeof createPayBridgeClient>;
