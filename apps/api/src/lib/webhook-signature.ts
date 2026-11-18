import { createHmac, timingSafeEqual } from "node:crypto";

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` */
export const SIGNATURE_HEADER = "x-paybridge-signature";

/** Older (or further in the future) than this, a signature is a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const hmac = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();

/** Signs a body the way PayBridge does. Used by tests and local tooling. */
export const signWebhook = (
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
) => `t=${timestamp},v1=${hmac(secret, timestamp, body).toString("hex")}`;

export type SignatureCheck =
  | { valid: true; timestamp: number }
  | { valid: false; reason: "malformed" | "mismatch" | "expired" };

/**
 * Checks an `X-PayBridge-Signature` header against the raw request body.
 *
 * - The body must be the exact bytes received. Re-serialised JSON won't match.
 * - Signatures are compared with `timingSafeEqual`, so response timing gives
 *   away nothing about how much of a forged signature was right.
 * - Several `v1=` values are accepted, so PayBridge can rotate secrets by
 *   sending both signatures for a while.
 * - The timestamp is checked only after the HMAC matches: without the secret,
 *   a caller learns nothing about which timestamps would pass.
 */
export const verifyWebhookSignature = (
  secret: string,
  header: string | undefined,
  body: string,
  {
    toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
    now = Math.floor(Date.now() / 1000),
  }: { toleranceSeconds?: number; now?: number } = {},
): SignatureCheck => {
  if (!header) return { valid: false, reason: "malformed" };

  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    }
    if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return { valid: false, reason: "malformed" };
  }

  const expected = hmac(secret, timestamp, body);
  // Every candidate is compared (no short-circuit), and all are 32 bytes.
  let matched = false;
  for (const signature of signatures) {
    if (timingSafeEqual(expected, signature)) matched = true;
  }
  if (!matched) return { valid: false, reason: "mismatch" };

  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, timestamp };
};
