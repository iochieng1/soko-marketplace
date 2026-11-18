import { describe, expect, it } from "vitest";

import {
  signWebhook,
  verifyWebhookSignature,
} from "../src/lib/webhook-signature.js";

const secret = "whsec_unit";
const body = '{"id":"evt_1","type":"payment.succeeded"}';
const now = 1_800_000_000;

describe("verifyWebhookSignature", () => {
  it("accepts a fresh signature over the exact body", () => {
    expect(
      verifyWebhookSignature(secret, signWebhook(secret, body, now), body, {
        now,
      }),
    ).toEqual({ valid: true, timestamp: now });
  });

  it("rejects a body that changed by one byte", () => {
    const header = signWebhook(secret, body, now);
    expect(
      verifyWebhookSignature(secret, header, body.replace("1", "2"), { now }),
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects a signature made with another secret", () => {
    const header = signWebhook("whsec_other", body, now);
    expect(verifyWebhookSignature(secret, header, body, { now })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("rejects a timestamp swapped onto an old signature", () => {
    const old = signWebhook(secret, body, now - 3600);
    const replayed = old.replace(`t=${now - 3600}`, `t=${now}`);
    expect(verifyWebhookSignature(secret, replayed, body, { now })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it.each([
    ["more than 5 minutes old", now - 301],
    ["more than 5 minutes in the future", now + 301],
  ])("rejects a signature %s", (_label, timestamp) => {
    expect(
      verifyWebhookSignature(
        secret,
        signWebhook(secret, body, timestamp),
        body,
        { now },
      ),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts one at exactly 5 minutes", () => {
    expect(
      verifyWebhookSignature(
        secret,
        signWebhook(secret, body, now - 300),
        body,
        { now },
      ).valid,
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["without a timestamp", "v1=" + "a".repeat(64)],
    ["without a signature", `t=${now}`],
    ["with a short signature", `t=${now},v1=abc`],
    ["with a non-numeric timestamp", "t=soon,v1=" + "a".repeat(64)],
  ])("treats a header %s as malformed", (_label, header) => {
    expect(verifyWebhookSignature(secret, header, body, { now })).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("accepts any one of several v1 signatures (secret rotation)", () => {
    const good = signWebhook(secret, body, now).split(",v1=")[1];
    const header = `t=${now},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyWebhookSignature(secret, header, body, { now }).valid).toBe(
      true,
    );
  });
});
