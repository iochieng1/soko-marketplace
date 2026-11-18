"use server";

import {
  cartQuoteRequestSchema,
  checkoutRequestSchema,
  formatKes,
  idempotencyKeySchema,
  MAX_ORDER_TOTAL_KES,
  type CartQuote,
} from "@soko/shared";
import { z } from "zod";

import { ApiError, placeOrder, quoteCart } from "@/lib/api";

export type QuoteResult = { quote: CartQuote } | { error: string };

/**
 * Validates the browser's cart against the API. Runs on the server because the
 * API URL is server-side config; the cart itself never leaves local storage
 * except as this request.
 */
export async function quoteCartAction(items: unknown): Promise<QuoteResult> {
  const body = cartQuoteRequestSchema.safeParse({ items });
  if (!body.success) return { error: "Your cart couldn't be read" };

  try {
    return { quote: await quoteCart(body.data) };
  } catch (err) {
    console.error(err);
    return { error: "We couldn't check your cart. Please try again." };
  }
}

export type CheckoutState = {
  error?: string;
  /** Set once the order is placed; the client then shows its payment screen. */
  orderId?: string;
};

const checkoutFormSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  customer_email: z.string(),
  customer_phone: z.string(),
  items: z.string(),
});

const checkoutErrors: Record<string, string> = {
  OUT_OF_STOCK: "Something in your cart just sold out. Review the cart above.",
  PRICE_CHANGED: "A price has changed. Review the cart above and try again.",
  PRODUCT_UNAVAILABLE:
    "Something in your cart is no longer for sale. Remove it and try again.",
  IDEMPOTENCY_KEY_REUSED:
    "Your cart changed after you pressed Pay. Refresh the page and try again.",
  ORDER_TOTAL_TOO_LARGE: `M-Pesa takes at most ${formatKes(MAX_ORDER_TOTAL_KES)} per payment.`,
};

/**
 * Places the order. The client generates the Idempotency-Key once per
 * attempt, so pressing Pay twice, or retrying after a timeout, can't place
 * two orders or send two M-Pesa prompts.
 */
export async function checkoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const form = checkoutFormSchema.safeParse(Object.fromEntries(formData));
  if (!form.success) return { error: "Please refresh the page and try again." };

  let items: unknown;
  try {
    items = JSON.parse(form.data.items);
  } catch {
    return { error: "Your cart couldn't be read" };
  }
  const body = checkoutRequestSchema.safeParse({
    customer_email: form.data.customer_email,
    customer_phone: form.data.customer_phone,
    items,
  });
  if (!body.success) {
    const field = body.error.issues[0]?.path[0];
    if (field === "customer_phone") {
      return { error: "Enter a Safaricom number, e.g. 0712 345 678." };
    }
    if (field === "customer_email") return { error: "Enter a valid email." };
    return { error: "Your cart couldn't be read" };
  }

  try {
    const order = await placeOrder(body.data, form.data.idempotency_key);
    return { orderId: order.id };
  } catch (err) {
    if (err instanceof ApiError && err.code && checkoutErrors[err.code]) {
      return { error: checkoutErrors[err.code] };
    }
    console.error(err);
    return { error: "We couldn't place your order. Please try again." };
  }
}
