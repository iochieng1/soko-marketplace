import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  africasTalkingSms,
  createNotifier,
  NotConfiguredError,
  NotifierError,
  PermanentNotifierError,
  resendEmail,
} from "../src/lib/notifier.js";

/** A local stand-in for both providers; tests never reach the network. */
describe("notifier providers", () => {
  let server: Server;
  let baseUrl: string;
  let requests: { path: string; headers: IncomingHttpHeaders; body: string }[];
  let reply: { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url!, headers: req.headers, body });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requests = [];
  });

  describe("Resend email", () => {
    const send = () =>
      resendEmail({ apiKey: "re_test", from: "Soko <hi@soko.test>", baseUrl })({
        to: "wanjiru@example.co.ke",
        subject: "Order SOKO1234 is confirmed",
        text: "Thanks!",
        idempotencyKey: "soko-outbox-7",
      });

    it("posts the email with the idempotency key", async () => {
      reply = { status: 200, body: { id: "em_1" } };
      await send();

      const [request] = requests;
      expect(request!.path).toBe("/emails");
      expect(request!.headers.authorization).toBe("Bearer re_test");
      expect(request!.headers["idempotency-key"]).toBe("soko-outbox-7");
      expect(JSON.parse(request!.body)).toEqual({
        from: "Soko <hi@soko.test>",
        to: ["wanjiru@example.co.ke"],
        subject: "Order SOKO1234 is confirmed",
        text: "Thanks!",
      });
    });

    it("fails permanently on an email Resend will never accept", async () => {
      reply = { status: 422, body: { message: "Invalid `to` field" } };
      const err = await send().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentNotifierError);
      expect(String(err)).toMatch(/Resend refused the email \(422/);
    });

    it.each([401, 429, 503])("fails retryably on a %i", async (status) => {
      reply = { status, body: { message: "nope" } };
      const err = await send().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotifierError);
      expect(err).not.toBeInstanceOf(PermanentNotifierError);
    });
  });

  describe("Africa's Talking SMS", () => {
    const send = () =>
      africasTalkingSms({ username: "sandbox", apiKey: "at_test", baseUrl })({
        to: "254712345678",
        message: "Soko: payment received",
      });

    const recipients = (statusCode: number, status: string) => ({
      SMSMessageData: {
        Message: "Sent to 1/1",
        Recipients: [{ statusCode, status, number: "+254712345678" }],
      },
    });

    it("posts the SMS to the international number", async () => {
      reply = { status: 201, body: recipients(101, "Success") };
      await send();

      const [request] = requests;
      expect(request!.path).toBe("/version1/messaging");
      expect(request!.headers.apikey).toBe("at_test");
      expect(Object.fromEntries(new URLSearchParams(request!.body))).toEqual({
        username: "sandbox",
        to: "+254712345678",
        message: "Soko: payment received",
      });
    });

    it("fails permanently for an invalid number, even on a 201", async () => {
      reply = { status: 201, body: recipients(403, "InvalidPhoneNumber") };
      const err = await send().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentNotifierError);
      expect(String(err)).toMatch(/InvalidPhoneNumber/);
    });

    it("fails retryably when the account is out of credit", async () => {
      reply = { status: 201, body: recipients(405, "InsufficientBalance") };
      const err = await send().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotifierError);
      expect(err).not.toBeInstanceOf(PermanentNotifierError);
    });

    it("treats a 2xx it can't read as sent, so the customer isn't texted again", async () => {
      reply = { status: 201, body: "OK" };
      await expect(send()).resolves.toBeUndefined();
    });

    it("throws on an HTTP error", async () => {
      reply = { status: 401, body: "The supplied authentication is invalid" };
      await expect(send()).rejects.toThrow(/refused the SMS \(401/);
    });
  });

  describe("createNotifier without credentials", () => {
    const logs: string[] = [];
    const log = {
      info: (_obj: unknown, msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
    } as unknown as FastifyBaseLogger;
    const message = { to: "254712345678", message: "hi" };

    it("logs messages instead of sending them in development", async () => {
      const notifier = createNotifier(
        { NODE_ENV: "development", EMAIL_FROM: "x@y.z" },
        log,
      );
      await expect(notifier.sms(message)).resolves.toBeUndefined();
      expect(logs.at(-1)).toMatch(/SMS not configured; logged instead/);
    });

    it("refuses to pretend in production, so messages stay queued", async () => {
      const notifier = createNotifier(
        { NODE_ENV: "production", EMAIL_FROM: "x@y.z" },
        log,
      );
      await expect(notifier.sms(message)).rejects.toBeInstanceOf(
        NotConfiguredError,
      );
      expect(logs).toContain(
        "RESEND_API_KEY is not set: confirmation emails will wait in the outbox",
      );
    });
    it("warns when only the SMS API key is set", () => {
      logs.length = 0;
      createNotifier(
        {
          NODE_ENV: "production",
          EMAIL_FROM: "x@y.z",
          RESEND_API_KEY: "re_x",
          AFRICASTALKING_API_KEY: "at_x",
        },
        log,
      );
      expect(logs).toEqual([
        "AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY must both be set: confirmation SMS will wait in the outbox",
      ]);
    });
  });
});
