import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  PAYBRIDGE_API_URL: "http://localhost:3100",
  PAYBRIDGE_API_KEY: "pk_test_key",
  PAYBRIDGE_WEBHOOK_SECRET: "whsec_test",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
    });
  });

  it("coerces PORT to a number", () => {
    expect(loadConfig({ ...validEnv, PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects an unknown NODE_ENV and a non-numeric PORT", () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: "staging", PORT: "abc" }),
    ).toThrow(/NODE_ENV[\s\S]*PORT/);
  });

  it("rejects a DATABASE_URL that is not a URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, DATABASE_URL: "not a url" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("fails fast and lists every missing variable", () => {
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET[\s\S]*PAYBRIDGE_API_URL[\s\S]*PAYBRIDGE_API_KEY[\s\S]*PAYBRIDGE_WEBHOOK_SECRET/,
    );
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "too-short" })).toThrow(
      /JWT_SECRET/,
    );
  });

  it("defaults token lifetimes", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
    });
  });

  it("rejects a PAYBRIDGE_API_URL that is not a URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, PAYBRIDGE_API_URL: "paybridge" }),
    ).toThrow(/PAYBRIDGE_API_URL/);
  });
});
