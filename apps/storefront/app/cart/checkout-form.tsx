"use client";

import { formatKes, type CartQuote } from "@soko/shared";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import type { CartLine } from "@/lib/cart";

import { checkoutAction, type CheckoutState } from "./actions";

const input =
  "mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none";

export function CheckoutForm({
  lines,
  quote,
}: {
  lines: CartLine[];
  quote: CartQuote | undefined;
}) {
  const router = useRouter();
  // One key per order attempt: a double click or a retry after a timeout
  // gets the same order back instead of a second one. Remounting the cart
  // (e.g. coming back after a failed payment) starts a new attempt.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    checkoutAction,
    {},
  );

  useEffect(() => {
    if (state.orderId) router.push(`/orders/${state.orderId}`);
  }, [state.orderId, router]);

  const canCheckout = quote?.can_checkout ?? false;
  const busy = pending || Boolean(state.orderId);

  return (
    <form
      action={action}
      className="w-full max-w-sm space-y-4 rounded-lg border border-stone-200 bg-white p-4"
    >
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(
          lines.map((l) => ({
            product_id: l.product_id,
            quantity: l.quantity,
            expected_price: l.price,
          })),
        )}
      />
      <label className="block text-sm font-medium text-stone-700">
        M-Pesa number
        <input
          className={input}
          name="customer_phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0712 345 678"
          required
        />
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Email for your receipt
        <input
          className={input}
          name="customer_email"
          type="email"
          autoComplete="email"
          required
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button
        disabled={!canCheckout || busy}
        className="w-full rounded-md bg-emerald-700 px-6 py-3 font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? "Sending M-Pesa prompt…"
          : quote && !canCheckout
            ? "Fix the items above to check out"
            : `Pay ${quote ? formatKes(quote.total) : ""} with M-Pesa`}
      </button>
    </form>
  );
}
