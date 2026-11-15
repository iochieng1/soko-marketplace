import { z } from "zod";

import { emailSchema, phoneSchema } from "./auth.js";
import { MAX_PRICE_KES } from "./products.js";

/** Most of one product a single order can hold. */
export const MAX_ITEM_QUANTITY = 100;
/** Most distinct products in one cart or order. */
export const MAX_CART_ITEMS = 50;
/**
 * Safaricom caps one M-Pesa transaction at KES 250,000, so an order that costs
 * more could never be paid.
 */
export const MAX_ORDER_TOTAL_KES = MAX_PRICE_KES;

export const cartItemSchema = z.object({
  // Lower-cased so "ABC…" and "abc…" count as the same product.
  product_id: z.uuid().transform((id) => id.toLowerCase()),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
  // The price the shopper last saw, in whole KES. Only used to flag a change:
  // what is charged always comes from the server.
  expected_price: z.number().int().positive().optional(),
});
export type CartItem = z.input<typeof cartItemSchema>;

const cartItemsSchema = z
  .array(cartItemSchema)
  .min(1, "The cart is empty")
  .max(MAX_CART_ITEMS)
  .refine(
    (items) => new Set(items.map((i) => i.product_id)).size === items.length,
    { message: "Each product may appear only once; combine the quantities" },
  );

/** `POST /v1/cart/quote` */
export const cartQuoteRequestSchema = z.object({ items: cartItemsSchema });
export type CartQuoteRequest = z.input<typeof cartQuoteRequestSchema>;

/**
 * Why a cart line can't be bought as it is.
 * - UNAVAILABLE: the product doesn't exist or isn't for sale any more.
 * - OUT_OF_STOCK: none available.
 * - INSUFFICIENT_STOCK: some available, but fewer than requested.
 * - PRICE_CHANGED: the price differs from `expected_price`. Informational:
 *   the line can still be bought at the new price.
 */
export const cartLineIssueSchema = z.enum([
  "UNAVAILABLE",
  "OUT_OF_STOCK",
  "INSUFFICIENT_STOCK",
  "PRICE_CHANGED",
]);
export type CartLineIssue = z.infer<typeof cartLineIssueSchema>;

export const cartQuoteLineSchema = z.object({
  product_id: z.uuid(),
  quantity: z.number().int().positive(),
  // null when the product is UNAVAILABLE.
  title: z.string().nullable(),
  slug: z.string().nullable(),
  unit_price: z.number().int().positive().nullable(),
  expected_price: z.number().int().positive().nullable(),
  // unit_price * quantity, or 0 when UNAVAILABLE.
  line_total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  issues: z.array(cartLineIssueSchema),
});
export type CartQuoteLine = z.infer<typeof cartQuoteLineSchema>;

export const cartQuoteSchema = z.object({
  items: z.array(cartQuoteLineSchema),
  // Sum of line totals at current server prices, in whole KES.
  total: z.number().int().nonnegative(),
  currency: z.literal("KES"),
  // False if any line is unavailable or short of stock, or the total is over
  // the M-Pesa limit. A price change alone doesn't block checkout.
  can_checkout: z.boolean(),
});
export type CartQuote = z.infer<typeof cartQuoteSchema>;

/** `POST /v1/checkout` (send an `Idempotency-Key` header too). */
export const checkoutRequestSchema = z.object({
  customer_email: emailSchema,
  // The M-Pesa number to send the payment prompt to.
  customer_phone: phoneSchema,
  items: cartItemsSchema,
});
export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;

/**
 * Client-generated, unique per order attempt (a UUID is ideal). Retrying with
 * the same key returns the original order instead of placing a second one.
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "Use printable ASCII without spaces");

export const orderStatusSchema = z.enum([
  "PENDING_PAYMENT",
  "PAID",
  "CANCELLED",
  "EXPIRED",
  "FULFILLED",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const orderItemSchema = z.object({
  product_id: z.uuid(),
  title: z.string(),
  quantity: z.number().int().positive(),
  // Price snapshot at checkout, in whole KES.
  unit_price: z.number().int().positive(),
  line_total: z.number().int().positive(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderSchema = z.object({
  id: z.uuid(),
  status: orderStatusSchema,
  customer_email: z.string(),
  customer_phone: z.string(),
  items: z.array(orderItemSchema),
  total: z.number().int().positive(),
  currency: z.literal("KES"),
  // Pay before this or the reserved stock is released.
  reserved_until: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
});
export type Order = z.infer<typeof orderSchema>;
