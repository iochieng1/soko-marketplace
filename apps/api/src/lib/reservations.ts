import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { inventory, orders, stockReservations } from "../db/schema.js";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface SweepResult {
  /** Orders moved from PENDING_PAYMENT to EXPIRED. */
  expiredOrders: number;
  /** Reservations moved from ACTIVE to RELEASED. */
  releasedReservations: number;
}

/**
 * Adjusts `inventory` for a set of (product, quantity) lines, one row at a
 * time in product id order. Checkout locks inventory rows in that same order,
 * so the two can't deadlock. Quantities for the same product are summed first.
 */
export const applyStockChanges = async (
  tx: Tx,
  lines: { productId: string; quantity: number }[],
  change: (quantity: number) => {
    onHand?: ReturnType<typeof sql>;
    reserved?: ReturnType<typeof sql>;
  },
) => {
  const totals = new Map<string, number>();
  for (const l of lines) {
    totals.set(l.productId, (totals.get(l.productId) ?? 0) + l.quantity);
  }
  const productIds = [...totals.keys()].sort();
  for (const productId of productIds) {
    await tx
      .update(inventory)
      .set({
        ...change(totals.get(productId)!),
        version: sql`${inventory.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(inventory.productId, productId));
  }
};

/**
 * Expires one batch of orders whose reservations ran out, in one transaction.
 *
 * Safe to run concurrently and repeatedly:
 *   - Orders are locked with FOR UPDATE SKIP LOCKED, so two sweepers split the
 *     work instead of both taking the same order. A payment confirmation locks
 *     the order too, so a payment and the sweeper can't interleave.
 *   - Only reservations still ACTIVE are released, and RETURNING gives exactly
 *     the rows this transaction flipped. Stock is returned for those rows
 *     only, so a reservation can never be released twice.
 */
const sweepBatch = async (db: Database, batchSize: number) =>
  db.transaction(async (tx) => {
    // Served by the partial index on expires_at WHERE status = 'ACTIVE'.
    const expired = await tx
      .select({ orderId: stockReservations.orderId })
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.status, "ACTIVE"),
          lte(stockReservations.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(stockReservations.expiresAt))
      .limit(batchSize);
    const candidates = [...new Set(expired.map((r) => r.orderId))];
    const full = expired.length === batchSize;
    if (candidates.length === 0) {
      return { expiredOrders: 0, releasedReservations: 0, full };
    }

    const locked = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(inArray(orders.id, candidates))
      .orderBy(asc(orders.id))
      .for("update", { skipLocked: true });
    const orderIds = locked.map((o) => o.id);
    if (orderIds.length === 0) {
      return { expiredOrders: 0, releasedReservations: 0, full: false };
    }

    const released = await tx
      .update(stockReservations)
      .set({ status: "RELEASED" })
      .where(
        and(
          inArray(stockReservations.orderId, orderIds),
          eq(stockReservations.status, "ACTIVE"),
          lte(stockReservations.expiresAt, sql`now()`),
        ),
      )
      .returning({
        productId: stockReservations.productId,
        quantity: stockReservations.quantity,
      });

    await applyStockChanges(tx, released, (q) => ({
      reserved: sql`${inventory.reserved} - ${q}`,
    }));

    const expiredOrders = await tx
      .update(orders)
      .set({ status: "EXPIRED", updatedAt: sql`now()` })
      .where(
        and(inArray(orders.id, orderIds), eq(orders.status, "PENDING_PAYMENT")),
      )
      .returning({ id: orders.id });

    return {
      expiredOrders: expiredOrders.length,
      releasedReservations: released.length,
      full,
    };
  });

/**
 * Returns stock held by abandoned checkouts to the pool: every ACTIVE
 * reservation past its expires_at is RELEASED, its quantity comes off
 * `inventory.reserved`, and its order becomes EXPIRED.
 *
 * Works in batches (one transaction each) so a backlog never holds locks for
 * long. Stops when a batch comes back short or finds nothing it could lock
 * (another sweeper has it).
 */
export const sweepExpiredReservations = async (
  db: Database,
  { batchSize = 500 }: { batchSize?: number } = {},
): Promise<SweepResult> => {
  const total: SweepResult = { expiredOrders: 0, releasedReservations: 0 };
  for (;;) {
    const batch = await sweepBatch(db, batchSize);
    total.expiredOrders += batch.expiredOrders;
    total.releasedReservations += batch.releasedReservations;
    if (!batch.full || batch.releasedReservations === 0) return total;
  }
};
