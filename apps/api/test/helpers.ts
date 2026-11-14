import { authResponseSchema } from "@soko/shared";
import { inject } from "vitest";

import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    JWT_SECRET: "test-only-jwt-secret-0123456789abcdef",
  }),
  ...overrides,
});

export const buildTestApp = (overrides: Partial<Config> = {}) =>
  buildApp(testConfig(overrides));

type TestApp = Awaited<ReturnType<typeof buildApp>>;

/** Registers a fresh seller with a unique email and returns its tokens. */
export const registerSeller = async (
  app: TestApp,
  overrides: Record<string, unknown> = {},
) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      name: "Test Seller",
      email: `seller-${crypto.randomUUID()}@example.co.ke`,
      phone: "0712345678",
      password: "correct horse battery",
      ...overrides,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const body = authResponseSchema.parse(res.json());
  return {
    ...body,
    auth: { authorization: `Bearer ${body.access_token}` },
  };
};
