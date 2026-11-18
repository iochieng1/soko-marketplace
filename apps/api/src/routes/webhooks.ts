import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { orders, processedWebhooks } from "../db/schema.js";
import { sendError } from "../lib/errors.js";
import {
  isFinalPayBridgeStatus,
  type PayBridgePayment,
  payBridgePaymentSchema,
} from "../lib/paybridge.js";
import { logApplied, paymentReference } from "../lib/payment-sync.js";
import { applyPaymentIn } from "../lib/payments.js";
import type { Tx } from "../lib/reservations.js";
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "../lib/webhook-signature.js";

/**
 * PayBridge's webhook envelope. `data` is checked loosely here: a status we
 * don't know yet must be acknowledged, not fail parsing (see below).
 */
const webhookEventSchema = z.looseObject({
  id: z.string().min(1).max(200),
  type: z.string(),
  data: z.looseObject({ id: z.string().min(1), status: z.string() }),
});

/**
 * Finds the order a payment belongs to. Normally by the stored payment id.
 *
 * Fallback: if checkout's call to PayBridge timed out, PayBridge may still
 * have sent the prompt, but Soko never learnt the payment id; and once the
 * order expires nothing asks again. The payment carries what Soko sent with
 * it (reference, amount, phone), so an order with no payment id that matches
 * all three is the one. The reference holds the first 8 hex digits of the
 * order id; requiring exactly one match keeps a collision from picking the
 * wrong order. The id is stored, so later events find it the normal way.
 */
const findOrder = async (tx: Tx, payment: PayBridgePayment) => {
  const [byId] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.paybridgePaymentId, payment.id));
  if (byId) return { id: byId.id, matchedBy: "payment_id" as const };

  const prefix = /^SOKO([0-9A-F]{8})$/.exec(payment.reference ?? "")?.[1];
  if (!prefix || !payment.phone) return undefined;
  const candidates = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        isNull(orders.paybridgePaymentId),
        sql`replace(${orders.id}::text, '-', '') like ${`${prefix.toLowerCase()}%`}`,
        eq(orders.total, payment.amount),
        eq(orders.customerPhone, payment.phone),
      ),
    )
    .limit(2);
  if (candidates.length !== 1) return undefined;
  const id = candidates[0]!.id;
  if (paymentReference(id) !== payment.reference) return undefined;
  await tx
    .update(orders)
    .set({ paybridgePaymentId: payment.id })
    .where(and(eq(orders.id, id), isNull(orders.paybridgePaymentId)));
  return { id, matchedBy: "reference" as const };
};

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
 *   - a signed event we can't use (an unreadable body, an unknown status or
 *     event type) is acknowledged with 200 and logged: retrying it would
 *     only deliver the same thing again;
 *   - a failure on our side (an order we can't find yet, a database error)
 *     is a non-2xx, so the event comes again later instead of being lost.
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

    const ignore = (reason: string, details: Record<string, unknown> = {}) => {
      request.log.error(details, `PayBridge webhook ignored: ${reason}`);
      return reply.send({ received: true, ignored: reason });
    };

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const envelope = webhookEventSchema.safeParse(json);
    if (!envelope.success) {
      return ignore("unreadable body", { issues: envelope.error.issues });
    }
    const event = envelope.data;
    const context = { eventId: event.id, paymentId: event.data.id };

    // Only final results change an order. Anything else (a status or event
    // type PayBridge adds later) is acknowledged and logged, but not
    // recorded, so it can't block the real result's event id.
    const status = event.data.status;
    if (!isFinalPayBridgeStatus(status)) {
      return ignore("not a final payment status", { ...context, status });
    }
    if (event.type !== `payment.${status.toLowerCase()}`) {
      return ignore("unexpected event type", {
        ...context,
        type: event.type,
        status,
      });
    }
    const parsed = payBridgePaymentSchema.safeParse(event.data);
    if (!parsed.success) {
      return ignore("unreadable payment", {
        ...context,
        issues: parsed.error.issues,
      });
    }
    const payment = parsed.data;

    const result = await app.db.transaction(async (tx) => {
      const order = await findOrder(tx, payment);
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
      return { kind: "applied" as const, order, applied };
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
        if (result.order.matchedBy === "reference") {
          request.log.warn(
            { ...context, orderId: result.order.id },
            "Matched a PayBridge payment to its order by reference",
          );
        }
        logApplied(request.log, result.order.id, payment, result.applied);
        return reply.send({ received: true });
    }
  });
};

export default webhookRoutes;
