import type { Order } from "@soko/shared";
import { asc, eq, min } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  orderItems,
  orders,
  products,
  stockReservations,
} from "../db/schema.js";

/** Loads an order with its items in the public wire format, or undefined. */
export const loadOrder = async (
  db: Database,
  by: { id: string } | { idempotencyKey: string },
): Promise<Order | undefined> => {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      "id" in by
        ? eq(orders.id, by.id)
        : eq(orders.idempotencyKey, by.idempotencyKey),
    );
  if (!order) return undefined;

  const [items, [reservation]] = await Promise.all([
    db
      .select({
        productId: orderItems.productId,
        title: products.title,
        quantity: orderItems.quantity,
        unitPrice: orderItems.unitPrice,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.productId)),
    db
      .select({ expiresAt: min(stockReservations.expiresAt) })
      .from(stockReservations)
      .where(eq(stockReservations.orderId, order.id)),
  ]);

  return {
    id: order.id,
    status: order.status,
    customer_email: order.customerEmail,
    customer_phone: order.customerPhone,
    items: items.map((i) => ({
      product_id: i.productId,
      title: i.title,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      line_total: i.unitPrice * i.quantity,
    })),
    total: order.total,
    currency: "KES",
    reserved_until: (reservation?.expiresAt ?? order.createdAt).toISOString(),
    created_at: order.createdAt.toISOString(),
  };
};
