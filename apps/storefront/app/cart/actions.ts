"use server";

import { cartQuoteRequestSchema, type CartQuote } from "@soko/shared";

import { quoteCart } from "@/lib/api";

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
