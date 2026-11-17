import {
  checkoutRequestSchema,
  idempotencyKeySchema,
  MAX_ORDER_TOTAL_KES,
  type Order,
} from "@soko/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { z } from "zod";

import {
  inventory,
  orderItems,
  orders,
  products,
  stockReservations,
} from "../db/schema.js";
import { isUniqueViolation, sendError } from "../lib/errors.js";
import { loadOrder } from "../lib/orders.js";
import { requestPayment } from "../lib/payment-sync.js";

type CheckoutBody = z.output<typeof checkoutRequestSchema>;

/** Thrown inside the transaction to roll it back and answer with an error. */
class CheckoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Does a retried request ask for the same order the key already placed? */
const sameRequest = (order: Order, body: CheckoutBody) => {
  if (
    order.customer_email !== body.customer_email ||
    order.customer_phone !== body.customer_phone ||
    order.items.length !== body.items.length
  ) {
    return false;
  }
  const placed = new Map(order.items.map((i) => [i.product_id, i.quantity]));
  return body.items.every((i) => placed.get(i.product_id) === i.quantity);
};

/**
 * Asks PayBridge for the order's M-Pesa prompt, then reloads the order: if
 * M-Pesa refused the push, it is PAYMENT_FAILED by now. On a retry this also
 * re-requests a payment whose first request never reached PayBridge (it is
 * idempotent on the order id, so it never sends a second prompt).
 */
const withPayment = async (
  app: FastifyInstance,
  request: FastifyRequest,
  order: Order,
): Promise<Order> => {
  if (order.status !== "PENDING_PAYMENT") return order;
  await requestPayment(app.paymentDeps(request.log), order.id);
  return (await loadOrder(app.db, { id: order.id })) ?? order;
};

/**
 * Answers a retry with the order its key already created. The request must
 * match that order: reusing a key for a different cart is a client bug, and
 * returning someone's order for a guessed key would leak their details.
 */
const replay = async (
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  order: Order,
  body: CheckoutBody,
) => {
  if (!sameRequest(order, body)) {
    return sendError(
      reply,
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different order",
    );
  }
  return reply
    .code(200)
    .header("idempotent-replayed", "true")
    .send(await withPayment(app, request, order));
};

const checkoutRoutes: FastifyPluginAsync = async (app) => {
  app.post("/checkout", async (request, reply) => {
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!key.success) {
      return sendError(
        reply,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Send a unique Idempotency-Key header (8-255 characters, e.g. a UUID)",
      );
    }
    const body = checkoutRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    const idempotencyKey = key.data;
    const { customer_email, customer_phone } = body.data;

    // Fast path for a plain retry. A retry that races the original past this
    // check is caught by the unique constraint below.
    const existing = await loadOrder(app.db, { idempotencyKey });
    if (existing) return replay(app, request, reply, existing, body.data);

    // Lock rows in one global order (product id) so two checkouts with the
    // same products can't each hold a row the other is waiting for: no
    // deadlocks, however the carts were ordered.
    const items = [...body.data.items].sort((a, b) =>
      a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0,
    );

    let orderId: string;
    try {
      orderId = await app.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: products.id, price: products.price })
          .from(products)
          .where(
            and(
              inArray(
                products.id,
                items.map((i) => i.product_id),
              ),
              eq(products.status, "ACTIVE"),
            ),
          );
        const priceOf = new Map(rows.map((r) => [r.id, r.price]));

        // Unit prices always come from the database, never the client.
        const lines = items.map((item) => {
          const price = priceOf.get(item.product_id);
          if (price === undefined) {
            throw new CheckoutError(
              409,
              "PRODUCT_UNAVAILABLE",
              "A product in the cart is no longer for sale",
              { product_id: item.product_id },
            );
          }
          if (
            item.expected_price !== undefined &&
            item.expected_price !== price
          ) {
            throw new CheckoutError(
              409,
              "PRICE_CHANGED",
              "A price in the cart has changed. Review the cart and try again",
              { product_id: item.product_id, unit_price: price },
            );
          }
          return { ...item, unitPrice: price };
        });

        const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
        if (total > MAX_ORDER_TOTAL_KES) {
          throw new CheckoutError(
            422,
            "ORDER_TOTAL_TOO_LARGE",
            `M-Pesa can't take more than KES ${MAX_ORDER_TOTAL_KES.toLocaleString("en-KE")} in one payment`,
            { total, max: MAX_ORDER_TOTAL_KES },
          );
        }

        // 1. The order and its items, with prices copied at checkout time.
        // Inserted first so a concurrent request with the same key blocks on
        // the unique index here, before touching any stock.
        const [order] = await tx
          .insert(orders)
          .values({
            customerEmail: customer_email,
            customerPhone: customer_phone,
            total,
            idempotencyKey,
          })
          .returning({ id: orders.id });
        if (!order) throw new Error("Order insert returned no row");

        await tx.insert(orderItems).values(
          lines.map((l) => ({
            orderId: order.id,
            productId: l.product_id,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        );

        // 2. Reserve stock: check and increment in one atomic statement, in
        // product id order. A concurrent checkout of the same product waits on
        // the row lock, then re-evaluates the WHERE against the committed row,
        // so the last unit can only be reserved once. Zero rows = not enough.
        for (const line of lines) {
          const reserved = await tx
            .update(inventory)
            .set({
              reserved: sql`${inventory.reserved} + ${line.quantity}`,
              version: sql`${inventory.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(inventory.productId, line.product_id),
                sql`${inventory.onHand} - ${inventory.reserved} >= ${line.quantity}`,
              ),
            )
            .returning({ productId: inventory.productId });
          if (reserved.length === 0) {
            throw new CheckoutError(
              409,
              "OUT_OF_STOCK",
              "Not enough stock for a product in the cart",
              { product_id: line.product_id },
            );
          }
        }

        // 3. Record the holds, so the sweeper can release them if the order
        // isn't paid in time.
        await tx.insert(stockReservations).values(
          lines.map((l) => ({
            orderId: order.id,
            productId: l.product_id,
            quantity: l.quantity,
            expiresAt: sql`now() + make_interval(secs => ${app.config.RESERVATION_TTL_SECONDS})`,
          })),
        );

        return order.id;
      });
    } catch (err) {
      if (err instanceof CheckoutError) {
        return sendError(reply, err.status, err.code, err.message, err.details);
      }
      // A concurrent request with the same key committed first; ours rolled
      // back without reserving anything. Answer with the order it placed.
      if (isUniqueViolation(err, "orders_idempotency_key_unique")) {
        const order = await loadOrder(app.db, { idempotencyKey });
        if (order) return replay(app, request, reply, order, body.data);
      }
      throw err;
    }

    // The stock is committed before PayBridge is called: an HTTP call must
    // never hold row locks open. If the call fails, the order waits as
    // PENDING_PAYMENT and a retry or status poll asks again.
    const placed = await loadOrder(app.db, { id: orderId });
    if (!placed) throw new Error("Placed order not found");
    return reply.code(201).send(await withPayment(app, request, placed));
  });
};

export default checkoutRoutes;
