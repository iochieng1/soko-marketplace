import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import type { Database } from "../db/client.js";
import { orderItems, orders, outbox, products } from "../db/schema.js";
import type { Notifier } from "./notifier.js";
import { paymentReference } from "./payment-sync.js";
import type { Tx } from "./reservations.js";

export const ORDER_CONFIRMATION_EMAIL = "order_confirmation.email";
export const ORDER_CONFIRMATION_SMS = "order_confirmation.sms";

/** What a confirmation message needs, frozen when the order was paid. */
export interface OrderConfirmationPayload {
  order_id: string;
  /** Email address or 2547XXXXXXXX phone number, depending on the channel. */
  to: string;
  /** Whole KES. */
  total: number;
  items: { title: string; quantity: number; line_total: number }[];
}

/**
 * Queues the "order paid" email and SMS. Must run in the transaction that
 * marks the order PAID: then either the order is paid and both messages are
 * queued, or neither happened.
 *
 * One row per channel, so a failing SMS gateway retries only the SMS and
 * never re-sends an email that already went out.
 */
export const enqueueOrderConfirmation = async (tx: Tx, orderId: string) => {
  const [order] = await tx
    .select({
      email: orders.customerEmail,
      phone: orders.customerPhone,
      total: orders.total,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return;

  const items = await tx
    .select({
      title: products.title,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.productId));

  const base = {
    order_id: orderId,
    total: order.total,
    items: items.map((i) => ({
      title: i.title,
      quantity: i.quantity,
      line_total: i.unitPrice * i.quantity,
    })),
  };
  await tx.insert(outbox).values([
    {
      type: ORDER_CONFIRMATION_EMAIL,
      payload: { ...base, to: order.email } satisfies OrderConfirmationPayload,
    },
    {
      type: ORDER_CONFIRMATION_SMS,
      payload: { ...base, to: order.phone } satisfies OrderConfirmationPayload,
    },
  ]);
};

const confirmationPayloadSchema = z.object({
  order_id: z.string(),
  to: z.string().min(1),
  total: z.number().int(),
  items: z.array(
    z.object({
      title: z.string(),
      quantity: z.number().int(),
      line_total: z.number().int(),
    }),
  ),
});

const kes = (amount: number) => `KES ${amount.toLocaleString("en-KE")}`;

/** Thrown for a row no number of retries will send. */
class Undeliverable extends Error {}

/** Sends one outbox row's message. Throws if it wasn't accepted. */
const send = async (
  notifier: Notifier,
  row: { id: number; type: string; payload: unknown },
) => {
  const parsed = confirmationPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new Undeliverable(`Unreadable payload for ${row.type}`);
  }
  const p = parsed.data;
  const reference = paymentReference(p.order_id);

  switch (row.type) {
    case ORDER_CONFIRMATION_EMAIL:
      return notifier.email({
        to: p.to,
        subject: `Order ${reference} is confirmed`,
        text: [
          "Thank you for shopping on Soko. We've received your M-Pesa payment.",
          "",
          ...p.items.map(
            (i) => `${i.quantity} x ${i.title}  ${kes(i.line_total)}`,
          ),
          "",
          `Total paid: ${kes(p.total)}`,
          `Order reference: ${reference}`,
        ].join("\n"),
        // Stable per row: a resend after a crash is the same email to Resend.
        idempotencyKey: `soko-outbox-${row.id}`,
      });
    case ORDER_CONFIRMATION_SMS:
      return notifier.sms({
        to: p.to,
        message: `Soko: payment of ${kes(p.total)} received for order ${reference}. Thank you!`,
      });
    default:
      throw new Undeliverable(`Unknown outbox message type ${row.type}`);
  }
};

export interface OutboxWorkerDeps {
  db: Database;
  notifier: Notifier;
  log: FastifyBaseLogger;
  /** Give up on a row after this many failed attempts. */
  maxAttempts: number;
  /** Wait before retry number `attempt` (1 = after the first failure). */
  backoffMs?: (attempt: number) => number;
}

/** 30 s, 1 min, 2 min, 4 min … capped at an hour. */
export const defaultBackoffMs = (attempt: number) =>
  Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000);

export type ProcessResult = "idle" | "sent" | "retry" | "gave_up";

/**
 * Claims the oldest due message, sends it and records the outcome, all in one
 * transaction.
 *
 * - `FOR UPDATE SKIP LOCKED` means a row being sent is invisible to every
 *   other worker, so two workers never send the same message at once. They
 *   just take the next row.
 * - If the process dies mid-send, the transaction never commits: the lock
 *   goes away, `processed_at` is still null, and the next worker sends it
 *   again. Nothing is lost. The price is that a message can go out twice
 *   when the provider accepted it but the commit didn't happen. The email
 *   carries an idempotency key tied to the row, so Resend drops the repeat.
 *   Africa's Talking has no such key, so a repeated SMS is possible in that
 *   narrow window.
 * - A failed send bumps `attempts` and pushes `next_attempt_at` back. After
 *   `maxAttempts` the row gets `failed_at` and an error log to alert on.
 */
export const processOutboxOnce = ({
  db,
  notifier,
  log,
  maxAttempts,
  backoffMs = defaultBackoffMs,
}: OutboxWorkerDeps): Promise<ProcessResult> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: outbox.id,
        type: outbox.type,
        payload: outbox.payload,
        attempts: outbox.attempts,
      })
      .from(outbox)
      .where(
        and(
          isNull(outbox.processedAt),
          isNull(outbox.failedAt),
          lte(outbox.nextAttemptAt, sql`now()`),
        ),
      )
      .orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return "idle";

    const attempts = row.attempts + 1;
    const context = { outboxId: row.id, type: row.type, attempts };
    try {
      await send(notifier, row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Undeliverable || attempts >= maxAttempts) {
        await tx
          .update(outbox)
          .set({ attempts, lastError: message, failedAt: sql`now()` })
          .where(eq(outbox.id, row.id));
        // ALERT: a customer won't hear about their order.
        log.error(
          { ...context, err },
          "Outbox message abandoned; it needs a person to look at it",
        );
        return "gave_up";
      }
      const delay = backoffMs(attempts);
      await tx
        .update(outbox)
        .set({
          attempts,
          lastError: message,
          nextAttemptAt: sql`now() + make_interval(secs => ${delay / 1000})`,
        })
        .where(eq(outbox.id, row.id));
      log.warn({ ...context, err, retryInMs: delay }, "Outbox send failed");
      return "retry";
    }

    await tx
      .update(outbox)
      .set({ attempts, processedAt: sql`now()`, lastError: null })
      .where(eq(outbox.id, row.id));
    log.info(context, "Outbox message sent");
    return "sent";
  });

/**
 * Processes due messages one by one until none is left (or `limit` is hit),
 * and returns how each went.
 */
export const drainOutbox = async (
  deps: OutboxWorkerDeps,
  { limit = 100 }: { limit?: number } = {},
) => {
  const counts: Record<Exclude<ProcessResult, "idle">, number> = {
    sent: 0,
    retry: 0,
    gave_up: 0,
  };
  for (let i = 0; i < limit; i++) {
    const result = await processOutboxOnce(deps);
    if (result === "idle") break;
    counts[result]++;
  }
  return counts;
};
