import { z } from "zod";

// An empty value (`RESEND_API_KEY=` in .env) counts as not set.
const optional = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // HS256 signing key for access tokens. 32+ chars: a short HMAC secret can be
  // brute-forced offline from any token.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // How long checkout holds stock for an unpaid order. Long enough to answer
  // an M-Pesa prompt, short enough that abandoned checkouts free stock soon.
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // How often the sweeper releases stock held by expired reservations.
  RESERVATION_SWEEP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  // PayBridge (M-Pesa STK push). Base URL without the /v1 path.
  PAYBRIDGE_API_URL: z.url(),
  PAYBRIDGE_API_KEY: z.string().min(1),
  // Verifies X-PayBridge-Signature on incoming webhooks.
  PAYBRIDGE_WEBHOOK_SECRET: z.string().min(1),
  // Least time between two PayBridge lookups for the same order when the
  // storefront polls its status. PayBridge allows 60 payment calls a minute
  // per API key, shared by every shopper, so polls can't each make one.
  PAYBRIDGE_SYNC_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  // Confirmation email via Resend. Without a key, emails are logged in
  // development and left queued (and retried) in production.
  RESEND_API_KEY: optional,
  EMAIL_FROM: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(3).default("Soko <onboarding@resend.dev>"),
  ),
  // Confirmation SMS via Africa's Talking. Username "sandbox" uses the
  // sandbox API (messages go to the simulator, not real phones).
  AFRICASTALKING_USERNAME: optional,
  AFRICASTALKING_API_KEY: optional,
  AFRICASTALKING_SENDER_ID: optional,
  // How often each instance looks for outbox messages to send.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  // Failed sends before a message is abandoned (and an error is logged).
  // With the default backoff, 8 attempts span about an hour.
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
});

export type Config = z.infer<typeof envSchema>;

/** Parses and validates environment variables, failing fast on bad config. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
};
