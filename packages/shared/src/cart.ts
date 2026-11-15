import { z } from "zod";

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
