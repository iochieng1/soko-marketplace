"use client";

import {
  formatKes,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_TOTAL_KES,
  type CartQuote,
  type CartQuoteLine,
} from "@soko/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

import { EmptyState, ErrorState } from "@/app/components";
import {
  acceptPrice,
  removeFromCart,
  setQuantity,
  useCart,
  type CartLine,
} from "@/lib/cart";

import { quoteCartAction } from "./actions";
import { CheckoutForm } from "./checkout-form";

const issueText = (line: CartQuoteLine): string | null => {
  if (line.issues.includes("UNAVAILABLE")) return "No longer for sale";
  if (line.issues.includes("OUT_OF_STOCK")) return "Sold out";
  if (line.issues.includes("INSUFFICIENT_STOCK")) {
    return `Only ${line.available} available`;
  }
  return null;
};

export function CartView() {
  const lines = useCart();
  const [result, setResult] = useState<{
    quote?: CartQuote;
    error?: string;
    // The cart the result belongs to, so a stale answer is never shown.
    for: CartLine[];
  } | null>(null);

  // Re-quote whenever the cart changes: prices and stock come from the API.
  useEffect(() => {
    if (lines.length === 0) return;
    let current = true;
    quoteCartAction(
      lines.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        expected_price: l.price,
      })),
    ).then(
      (r) => current && setResult({ ...r, for: lines }),
      () =>
        current &&
        setResult({ error: "We couldn't check your cart.", for: lines }),
    );
    return () => {
      current = false;
    };
  }, [lines]);

  if (lines.length === 0) {
    return (
      <EmptyState>
        Your cart is empty.{" "}
        <Link href="/" className="text-emerald-800 hover:underline">
          Browse products
        </Link>
      </EmptyState>
    );
  }

  const fresh = result?.for === lines ? result : null;
  if (fresh?.error) {
    return <ErrorState title="Cart unavailable">{fresh.error}</ErrorState>;
  }
  const quote = fresh?.quote;
  const quoted = new Map(quote?.items.map((q) => [q.product_id, q]));

  return (
    <div className="space-y-6">
      <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
        {lines.map((line) => {
          const q = quoted.get(line.product_id);
          const problem = q ? issueText(q) : null;
          const priceChanged = q?.issues.includes("PRICE_CHANGED");
          return (
            <li
              key={line.product_id}
              className="flex flex-wrap items-center gap-4 p-4"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/products/${line.slug}`}
                  className="font-medium hover:underline"
                >
                  {q?.title ?? line.title}
                </Link>
                <p className="text-sm text-stone-600">
                  {formatKes(q?.unit_price ?? line.price)} each
                </p>
                {priceChanged && q?.unit_price && (
                  <p className="text-sm text-amber-700">
                    Price changed from {formatKes(line.price)}.{" "}
                    <button
                      className="underline"
                      onClick={() =>
                        acceptPrice(line.product_id, q.unit_price!)
                      }
                    >
                      OK
                    </button>
                  </p>
                )}
                {problem && (
                  <p className="text-sm font-medium text-red-700">{problem}</p>
                )}
              </div>

              <label className="text-sm text-stone-600">
                <span className="sr-only">Quantity of {line.title}</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_ITEM_QUANTITY}
                  value={line.quantity}
                  onChange={(e) => {
                    const n = e.currentTarget.valueAsNumber;
                    if (Number.isFinite(n) && n >= 1) {
                      setQuantity(line.product_id, n);
                    }
                  }}
                  className="w-20 rounded-md border border-stone-300 px-2 py-1"
                />
              </label>

              <p className="w-28 text-right font-medium">
                {q ? formatKes(q.line_total) : "…"}
              </p>

              <button
                onClick={() => removeFromCart(line.product_id)}
                className="text-sm text-stone-500 hover:text-red-700"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col items-end gap-3">
        <p className="text-lg">
          Total{" "}
          <span className="font-semibold">
            {quote ? formatKes(quote.total) : "…"}
          </span>
        </p>
        {quote && quote.total > MAX_ORDER_TOTAL_KES && (
          <p className="text-sm text-red-700">
            M-Pesa takes at most {formatKes(MAX_ORDER_TOTAL_KES)} per payment.
            Split this into smaller orders.
          </p>
        )}
        <CheckoutForm lines={lines} quote={quote} />
      </div>
    </div>
  );
}
