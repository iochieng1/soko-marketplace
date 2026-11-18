import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

import type { Database } from "../db/client.js";
import { orders } from "../db/schema.js";
import type { PayBridgeClient, PayBridgePayment } from "./paybridge.js";
import { confirmPayment, failPayment } from "./payments.js";

export interface PaymentDeps {
  db: Database;
  redis: Redis;
  paybridge: PayBridgeClient;
  log: FastifyBaseLogger;
  syncIntervalSeconds: number;
}

/**
 * What the customer sees as the M-Pesa account number: at most 12 characters,
 * and enough of the order id to find it from a statement.
 */
export const paymentReference = (orderId: string) =>
  `SOKO${orderId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;

const PAYMENT_DESCRIPTION = "Soko order";

const loadPaymentState = async (db: Database, orderId: string) => {
  const [row] = await db
    .select({
      status: orders.status,
      phone: orders.customerPhone,
      total: orders.total,
      paymentId: orders.paybridgePaymentId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row;
};

const storePaymentId = (db: Database, orderId: string, paymentId: string) =>
  db
    .update(orders)
    .set({ paybridgePaymentId: paymentId })
    .where(and(eq(orders.id, orderId), isNull(orders.paybridgePaymentId)));

/**
 * Applies a PayBridge payment's status to its order. Pending payments are
 * left alone; both outcomes are idempotent, so applying one twice (a poll and
 * a webhook, say) is harmless.
 */
export const applyPaymentStatus = async (
  deps: PaymentDeps,
  orderId: string,
  orderTotal: number,
  payment: PayBridgePayment,
) => {
  switch (payment.status) {
    case "SUCCEEDED": {
      // Soko set the amount, so a mismatch means something is badly wrong.
      // Don't mark the order paid; leave it for a person to look at.
      if (payment.amount !== orderTotal) {
        deps.log.error(
          {
            orderId,
            paymentId: payment.id,
            amount: payment.amount,
            orderTotal,
          },
          "PayBridge payment amount doesn't match the order total",
        );
        return;
      }
      const outcome = await confirmPayment(deps.db, orderId);
      deps.log.info(
        { orderId, paymentId: payment.id, outcome },
        "Payment succeeded",
      );
      return;
    }
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT": {
      const outcome = await failPayment(deps.db, orderId);
      deps.log.info(
        {
          orderId,
          paymentId: payment.id,
          paymentStatus: payment.status,
          reason: payment.result_desc,
          outcome,
        },
        "Payment did not go through",
      );
      return;
    }
    default:
      return;
  }
};

/**
 * Asks PayBridge to send the order's M-Pesa prompt, unless one was already
 * requested. Safe to call any number of times: the Idempotency-Key is the
 * order id, so PayBridge sends at most one push per order.
 *
 * Never throws for PayBridge trouble. If PayBridge can't be reached the order
 * stays PENDING_PAYMENT without a payment id, and the next call (a checkout
 * retry or a status poll) tries again. If the reservation runs out first,
 * the sweeper releases the stock as usual.
 */
export const requestPayment = async (deps: PaymentDeps, orderId: string) => {
  const order = await loadPaymentState(deps.db, orderId);
  if (!order || order.status !== "PENDING_PAYMENT" || order.paymentId) return;

  const result = await deps.paybridge.createPayment(
    {
      phone: order.phone,
      amount: order.total,
      reference: paymentReference(orderId),
      description: PAYMENT_DESCRIPTION,
    },
    orderId,
  );

  switch (result.kind) {
    case "accepted":
      await storePaymentId(deps.db, orderId, result.payment.id);
      // Normally PENDING; a callback can, rarely, settle it first.
      await applyPaymentStatus(deps, orderId, order.total, result.payment);
      return;
    case "rejected":
      await storePaymentId(deps.db, orderId, result.payment.id);
      await applyPaymentStatus(deps, orderId, order.total, result.payment);
      return;
    case "invalid":
      // Nothing will make PayBridge accept this order, so stop holding stock.
      deps.log.error(
        { orderId, status: result.status, message: result.message },
        "PayBridge refused the payment request",
      );
      await failPayment(deps.db, orderId);
      return;
    case "unavailable":
      deps.log.warn(
        { orderId, reason: result.reason },
        "PayBridge unavailable; payment will be requested again",
      );
      return;
  }
};

/**
 * Brings an unpaid order up to date with PayBridge. Called when the
 * storefront polls the order, as a fallback for webhooks that are late or
 * lost: it requests the payment if that never got through, or looks up the
 * payment's status and applies it.
 *
 * At most one call per order per `syncIntervalSeconds` reaches PayBridge,
 * however many tabs are polling. PayBridge rate-limits the whole API key, so
 * this keeps one shopper's polling from using up everyone's budget.
 *
 * Never throws: a failed lookup just leaves the order as it was.
 */
export const syncPayment = async (deps: PaymentDeps, orderId: string) => {
  try {
    const order = await loadPaymentState(deps.db, orderId);
    if (!order || order.status !== "PENDING_PAYMENT") return;

    const acquired = await deps.redis.set(
      `paybridge:sync:${orderId}`,
      "1",
      "EX",
      deps.syncIntervalSeconds,
      "NX",
    );
    if (acquired === null) return;

    if (!order.paymentId) {
      await requestPayment(deps, orderId);
      return;
    }

    const payment = await deps.paybridge.getPayment(order.paymentId);
    if (!payment) {
      deps.log.error(
        { orderId, paymentId: order.paymentId },
        "PayBridge has no record of the order's payment",
      );
      return;
    }
    await applyPaymentStatus(deps, orderId, order.total, payment);
  } catch (err) {
    deps.log.warn({ err, orderId }, "Payment status sync failed");
  }
};
