import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  africasTalkingSms,
  createNotifier,
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

    it("throws when Resend refuses it", async () => {
      reply = { status: 422, body: { message: "Invalid `to` field" } };
      await expect(send()).rejects.toThrow(/Resend refused the email \(422/);
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

    it("throws when the recipient wasn't accepted, even on a 201", async () => {
      reply = { status: 201, body: recipients(403, "InvalidPhoneNumber") };
      await expect(send()).rejects.toThrow(/InvalidPhoneNumber/);
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
      await expect(notifier.sms(message)).rejects.toThrow(
        /No SMS provider is configured/,
      );
      expect(logs).toContain(
        "RESEND_API_KEY is not set: confirmation emails can't be sent",
      );
    });
  });
});
