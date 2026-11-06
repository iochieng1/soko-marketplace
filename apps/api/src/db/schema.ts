import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Design goal: never oversell.
 *
 * Stock is guarded in three layers, from cheapest to strongest:
 *   1. The checkout flow reserves stock with a conditional UPDATE
 *      (`... SET reserved = reserved + $q WHERE reserved + $q <= on_hand`),
 *      which is atomic under concurrency without an explicit row lock.
 *   2. Reservations expire, so abandoned carts and failed M-Pesa prompts give
 *      their stock back instead of locking it forever.
 *   3. CHECK constraints on `inventory` make an oversold state impossible to
 *      store, even if application code has a bug or someone edits rows by hand.
 *
 * Money is integer whole Kenyan shillings everywhere (M-Pesa has no cents).
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const productStatus = pgEnum("product_status", [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
]);

export const orderStatus = pgEnum("order_status", [
  "PENDING_PAYMENT",
  "PAID",
  "CANCELLED",
  "EXPIRED",
  "FULFILLED",
]);

export const reservationStatus = pgEnum("reservation_status", [
  "ACTIVE", // holding stock (counted in inventory.reserved)
  "CONSUMED", // payment succeeded: stock left on_hand for good
  "RELEASED", // expired or cancelled: stock returned
]);

export const sellers = pgTable(
  "sellers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    // Normalised to 2547XXXXXXXX / 2541XXXXXXXX (M-Pesa MSISDN format).
    phone: text("phone").notNull(),
    createdAt: createdAt(),
  },
  // Case-insensitive uniqueness: Jane@x.com and jane@x.com are one seller.
  (t) => [uniqueIndex("sellers_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    // Whole KES. Integers only: no floating-point money.
    price: integer("price").notNull(),
    status: productStatus("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("products_price_positive", sql`${t.price} > 0`),
    index("products_seller_idx").on(t.sellerId),
    // Serves the public catalogue: WHERE status = 'ACTIVE'
    // ORDER BY created_at DESC, id DESC (keyset pagination).
    index("products_status_created_idx").on(
      t.status,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

/**
 * One row per product. `on_hand` is physical stock; `reserved` is stock held
 * by unpaid orders. Available to sell = on_hand - reserved.
 */
export const inventory = pgTable(
  "inventory",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    // Bumped on every write; lets admin edits use optimistic concurrency
    // (UPDATE ... WHERE version = $seen) so they can't clobber a checkout.
    version: integer("version").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    // LAST LINE OF DEFENCE against overselling. Checkout code is supposed to
    // reserve with a conditional UPDATE, but if any code path (a bug, a race we
    // didn't think of, a manual SQL fix) tries to reserve more than exists, or
    // release more than was reserved, Postgres rejects the write and the
    // transaction rolls back. Correctness doesn't depend on every caller being
    // right. Implies on_hand >= 0.
    check("inventory_reserved_non_negative", sql`${t.reserved} >= 0`),
    check(
      "inventory_reserved_within_on_hand",
      sql`${t.reserved} <= ${t.onHand}`,
    ),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerEmail: text("customer_email").notNull(),
    // M-Pesa number the STK push goes to (2547XXXXXXXX).
    customerPhone: text("customer_phone").notNull(),
    status: orderStatus("status").notNull().default("PENDING_PAYMENT"),
    // Sum of order_items quantity * unit_price, in whole KES.
    total: integer("total").notNull(),
    // Client-supplied Idempotency-Key: a retried "place order" request returns
    // the original order instead of reserving stock twice.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // Set once PayBridge accepts the payment; webhooks look the order up by it.
    paybridgePaymentId: text("paybridge_payment_id").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("orders_total_positive", sql`${t.total} > 0`)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    // Price snapshot at checkout: later price edits must not change what the
    // customer was charged.
    unitPrice: integer("unit_price").notNull(),
  },
  (t) => [
    check("order_items_quantity_positive", sql`${t.quantity} > 0`),
    check("order_items_unit_price_positive", sql`${t.unitPrice} > 0`),
    unique("order_items_order_product_uq").on(t.orderId, t.productId),
  ],
);

/**
 * Stock held for an unpaid order. Created in the same transaction that
 * increments inventory.reserved, so the two always agree.
 *
 * Expiry: an M-Pesa STK prompt can be ignored, cancelled or time out, and the
 * webhook might never arrive. A sweeper periodically finds ACTIVE reservations
 * past expires_at, marks them RELEASED, decrements inventory.reserved and
 * expires the order — all in one transaction, using conditional updates so a
 * late "payment succeeded" webhook and the sweeper can't both win.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    status: reservationStatus("status").notNull().default("ACTIVE"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("stock_reservations_quantity_positive", sql`${t.quantity} > 0`),
    index("stock_reservations_order_idx").on(t.orderId),
    // Partial index for the expiry sweeper: only ACTIVE rows are indexed, so it
    // stays small no matter how many historical reservations accumulate.
    index("stock_reservations_active_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'ACTIVE'`),
  ],
);

/**
 * PayBridge delivers webhooks at least once, so the same event can arrive
 * twice (retries, network blips). Inserting the event id here in the same
 * transaction as the order update makes processing idempotent: a duplicate
 * hits the primary key and is acknowledged without being applied again.
 */
export const processedWebhooks = pgTable("processed_webhooks", {
  eventId: text("event_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Transactional outbox. Side effects (confirmation email/SMS) are written as
 * rows in the same transaction that marks an order PAID, then a worker sends
 * them and sets processed_at. This avoids both failure modes of sending
 * inline: an email for a transaction that rolled back, or a committed order
 * whose email was lost because the process crashed. Delivery is at-least-once,
 * so consumers must tolerate duplicates.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    // The worker polls unprocessed rows in id order (FOR UPDATE SKIP LOCKED).
    index("outbox_unprocessed_idx")
      .on(t.id)
      .where(sql`${t.processedAt} is null`),
  ],
);
