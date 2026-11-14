import { describe, expect, it } from "vitest";

import { normalizeKenyanPhone, registerRequestSchema } from "../src/index.js";

describe("normalizeKenyanPhone", () => {
  it.each([
    ["0712345678", "254712345678"],
    ["0712 345 678", "254712345678"],
    ["+254712345678", "254712345678"],
    ["254-712-345-678", "254712345678"],
    ["712345678", "254712345678"],
    ["0110345678", "254110345678"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each(["", "0812345678", "07123", "+1 415 555 0100", "07123456789", "abc"])(
    "rejects %j",
    (input) => {
      expect(normalizeKenyanPhone(input)).toBeNull();
    },
  );
});

describe("registerRequestSchema", () => {
  const valid = {
    name: " Mama Wanjiku ",
    email: " Duka@Example.co.ke ",
    phone: "0712 345 678",
    password: "correct horse",
  };

  it("trims fields and normalises the phone", () => {
    expect(registerRequestSchema.parse(valid)).toEqual({
      name: "Mama Wanjiku",
      email: "Duka@Example.co.ke",
      phone: "254712345678",
      password: "correct horse",
    });
  });

  it.each([
    ["a short password", { password: "short" }],
    ["a bad email", { email: "not-an-email" }],
    ["a non-Kenyan phone", { phone: "+1 415 555 0100" }],
    ["an empty name", { name: "   " }],
  ])("rejects %s", (_label, override) => {
    expect(
      registerRequestSchema.safeParse({ ...valid, ...override }).success,
    ).toBe(false);
  });
});
