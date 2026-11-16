import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  inventory,
  orderItems,
  orders,
  stockReservations,
} from "../db/schema.js";
import { applyStockChanges } from "./reservations.js";

export type PaymentOutcome =
  /** The order was waiting for payment and its stock was still held. */
  | "PAID"
  /** The order had expired, but the stock was still there to re-reserve. */
  | "PAID_LATE"
  /** The order had expired (or was cancelled) and the stock is gone. */
  | "REFUND_PENDING"
  /** The order was already settled; nothing changed (duplicate delivery). */
  | "ALREADY_SETTLED";

/** Rolls back the re-reservation savepoint when a line is out of stock. */
class StockGone extends Error {}

/**
 * Applies a successful payment to an order. Called by the payment webhook.
 *
 * The order row is locked first, which serialises this against the expiry
 * sweeper (it locks orders too), so a payment and an expiry can't both apply:
 *
 *   - PENDING_PAYMENT: the reservations are consumed. The stock leaves
 *     on_hand for good and stops counting as reserved. This holds even if
 *     expires_at has passed but the sweeper hasn't reached the order yet,
 *     because the stock is still held.
 *   - EXPIRED: the sweeper already gave the stock back. Try to take it again,
 *     all lines or none; if any line is short the order is flagged
 *     REFUND_PENDING and inventory is left exactly as it was.
 *   - CANCELLED: the customer paid for an order that no longer exists, so it
 *     is flagged REFUND_PENDING.
 *   - Anything else is already settled, so a duplicate is a no-op.
 *
 * Returns undefined if the order doesn't exist.
 */
export const confirmPayment = async (
  db: Database,
  orderId: string,
): Promise<PaymentOutcome | undefined> =>
  db.transaction(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!order) return undefined;

    const settle = async (status: "PAID" | "REFUND_PENDING") => {
      await tx
        .update(orders)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(orders.id, orderId));
    };

    switch (order.status) {
      case "PENDING_PAYMENT": {
        const consumed = await tx
          .update(stockReservations)
          .set({ status: "CONSUMED" })
          .where(
            and(
              eq(stockReservations.orderId, orderId),
              eq(stockReservations.status, "ACTIVE"),
            ),
          )
          .returning({
            productId: stockReservations.productId,
            quantity: stockReservations.quantity,
          });
        await applyStockChanges(tx, consumed, (q) => ({
          onHand: sql`${inventory.onHand} - ${q}`,
          reserved: sql`${inventory.reserved} - ${q}`,
        }));
        await settle("PAID");
        return "PAID";
      }

      case "EXPIRED": {
        const items = await tx
          .select({
            productId: orderItems.productId,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .orderBy(asc(orderItems.productId));

        try {
          // Savepoint: if a later line is short, the earlier ones roll back.
          await tx.transaction(async (sp) => {
            // Same conditional UPDATE as checkout, in the same product id
            // order, but taking the stock straight out of on_hand: the order
            // is paid, so there's nothing left to hold it for.
            for (const item of items) {
              const taken = await sp
                .update(inventory)
                .set({
                  onHand: sql`${inventory.onHand} - ${item.quantity}`,
                  version: sql`${inventory.version} + 1`,
                  updatedAt: sql`now()`,
                })
                .where(
                  and(
                    eq(inventory.productId, item.productId),
                    sql`${inventory.onHand} - ${inventory.reserved} >= ${item.quantity}`,
                  ),
                )
                .returning({ productId: inventory.productId });
              if (taken.length === 0) throw new StockGone();
            }
            // Recorded as consumed holds, so stock movements stay traceable.
            await sp.insert(stockReservations).values(
              items.map((i) => ({
                orderId,
                productId: i.productId,
                quantity: i.quantity,
                status: "CONSUMED" as const,
                expiresAt: sql`now()`,
              })),
            );
          });
        } catch (err) {
          if (!(err instanceof StockGone)) throw err;
          await settle("REFUND_PENDING");
          return "REFUND_PENDING";
        }
        await settle("PAID");
        return "PAID_LATE";
      }

      case "CANCELLED":
        await settle("REFUND_PENDING");
        return "REFUND_PENDING";

      default:
        return "ALREADY_SETTLED";
    }
  });
