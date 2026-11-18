import { asc, eq } from "drizzle-orm";

import { orderItems, orders, outbox, products } from "../db/schema.js";
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
