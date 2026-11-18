import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { orders, processedWebhooks } from "../db/schema.js";
import { sendError } from "../lib/errors.js";
import { payBridgePaymentSchema } from "../lib/paybridge.js";
import { logApplied } from "../lib/payment-sync.js";
import { applyPaymentIn } from "../lib/payments.js";
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "../lib/webhook-signature.js";

/** PayBridge's webhook body: one event per payment's final status. */
const webhookEventSchema = z.looseObject({
  id: z.string().min(1).max(200),
  type: z.string(),
  data: payBridgePaymentSchema,
});

const FINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

/**
 * `POST /v1/webhooks/paybridge`: payment results pushed by PayBridge.
 *
 * Nothing in the body is trusted until the HMAC over the raw bytes checks
 * out, so this plugin keeps JSON bodies as strings (the parser is scoped to
 * this plugin; other routes still get parsed objects).
 *
 * PayBridge delivers at least once and retries anything that isn't a 2xx,
 * so:
 *   - a duplicate is acknowledged with 200 and changes nothing;
 *   - a failure on our side (an unknown payment id, a database error) is a
 *     non-2xx, so the event comes again later instead of being lost.
 */
const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.post("/webhooks/paybridge", async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : "";
    const header = request.headers[SIGNATURE_HEADER];
    const check = verifyWebhookSignature(
      app.config.PAYBRIDGE_WEBHOOK_SECRET,
      Array.isArray(header) ? header[0] : header,
      raw,
    );
    if (!check.valid) {
      request.log.warn(
        { reason: check.reason },
        "Rejected PayBridge webhook with a bad signature",
      );
      return sendError(
        reply,
        401,
        "INVALID_SIGNATURE",
        "Webhook signature is missing, invalid or expired",
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = webhookEventSchema.safeParse(json);
    if (!parsed.success) {
      // Signed by PayBridge but not a shape we understand: retrying won't
      // help, and a person needs to see it.
      request.log.error(
        { issues: parsed.error.issues },
        "Signed PayBridge webhook has an unexpected body",
      );
      return sendError(reply, 400, "INVALID_EVENT", "Unrecognised event body");
    }
    const event = parsed.data;
    const payment = event.data;
    const context = { eventId: event.id, paymentId: payment.id };

    // PayBridge only sends final statuses. Anything else is acknowledged but
    // not recorded, so it can't block the real result's event id later.
    if (!FINAL_STATUSES.has(payment.status)) {
      return reply.send({ received: true });
    }

    const result = await app.db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.paybridgePaymentId, payment.id));
      if (!order) return { kind: "unknown_payment" as const };

      // The dedupe record commits or rolls back with the order update. A
      // concurrent duplicate blocks on this primary key until the first
      // commits, then inserts nothing.
      const inserted = await tx
        .insert(processedWebhooks)
        .values({ eventId: event.id })
        .onConflictDoNothing()
        .returning({ eventId: processedWebhooks.eventId });
      if (inserted.length === 0) return { kind: "duplicate" as const };

      const applied = await applyPaymentIn(tx, order.id, payment);
      return { kind: "applied" as const, orderId: order.id, applied };
    });

    switch (result.kind) {
      case "unknown_payment":
        // Usually the webhook beat checkout storing the payment id; the
        // retry a minute later will find it.
        request.log.warn(context, "PayBridge webhook for an unknown payment");
        return sendError(
          reply,
          404,
          "PAYMENT_NOT_FOUND",
          "No order has this payment",
        );
      case "duplicate":
        request.log.info(context, "Duplicate PayBridge webhook ignored");
        return reply.send({ received: true, duplicate: true });
      case "applied":
        logApplied(request.log, result.orderId, payment, result.applied);
        return reply.send({ received: true });
    }
  });
};

export default webhookRoutes;
