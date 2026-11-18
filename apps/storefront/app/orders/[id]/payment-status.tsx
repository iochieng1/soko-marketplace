"use client";

import {
  formatKes,
  isOrderSettled,
  type OrderStatus,
  type OrderStatusResponse,
} from "@soko/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

import { clearCart } from "@/lib/cart";

import { orderStatusAction } from "./actions";

const POLL_MS = 3_000;
/** Back off while the API is unreachable, up to this. */
const MAX_POLL_MS = 30_000;

const paidStatuses: OrderStatus[] = ["PAID", "FULFILLED"];

/**
 * Minutes:seconds until `until`, or null before the first client tick. The
 * clock isn't read during render, so the server HTML and the first client
 * render match (otherwise React reports a hydration mismatch).
 */
function useCountdown(until: string) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
  const left = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-700"
    />
  );
}

function Pending({
  order,
  offline,
}: {
  order: OrderStatusResponse;
  offline: boolean;
}) {
  const left = useCountdown(order.reserved_until);
  return (
    <div className="space-y-4 text-center">
      <Spinner />
      <h1 className="text-2xl font-semibold">Check your phone</h1>
      <p className="text-stone-700">
        We&apos;ve sent an M-Pesa prompt for{" "}
        <span className="font-semibold">{formatKes(order.total)}</span>. Enter
        your M-Pesa PIN to pay.
      </p>
      <p className="text-sm text-stone-500">
        {left ? `Your items are held for ${left}. ` : ""}This page updates by
        itself.
      </p>
      {offline && (
        <p role="status" className="text-sm text-amber-700">
          We&apos;re having trouble checking your payment. Still trying…
        </p>
      )}
    </div>
  );
}

function Outcome({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "good" | "bad";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={`space-y-3 rounded-lg border p-6 text-center ${
        tone === "good"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-red-200 bg-red-50 text-red-900"
      }`}
    >
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

const backToCart = (
  <Link href="/cart" className="inline-block font-medium underline">
    Back to your cart
  </Link>
);

export function PaymentStatus({ initial }: { initial: OrderStatusResponse }) {
  const [order, setOrder] = useState(initial);
  const [offline, setOffline] = useState(false);

  // Poll until the payment is settled one way or the other.
  useEffect(() => {
    if (isOrderSettled(order.status)) return;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;

    const poll = async () => {
      const result = await orderStatusAction(initial.id).catch(() => ({
        error: true as const,
      }));
      if (!active) return;
      if ("status" in result) {
        setOffline(false);
        delay = POLL_MS;
        setOrder(result.status);
        if (isOrderSettled(result.status.status)) return;
      } else {
        setOffline(true);
        delay = Math.min(delay * 2, MAX_POLL_MS);
      }
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [initial.id, order.status]);

  // The cart is only emptied once the money is in: after a failed payment the
  // shopper can go straight back and try again.
  const paid = paidStatuses.includes(order.status);
  useEffect(() => {
    if (paid) clearCart();
  }, [paid]);

  switch (order.status) {
    case "PENDING_PAYMENT":
      return <Pending order={order} offline={offline} />;
    case "PAID":
    case "FULFILLED":
      return (
        <Outcome title="Payment received" tone="good">
          <p>
            Thank you! We&apos;ve received {formatKes(order.total)} and your
            order is confirmed.
          </p>
          <Link href="/" className="inline-block font-medium underline">
            Keep shopping
          </Link>
        </Outcome>
      );
    case "PAYMENT_FAILED":
      return (
        <Outcome title="Payment didn't go through" tone="bad">
          <p>
            The M-Pesa payment was cancelled, failed or timed out. You
            haven&apos;t been charged, and your cart is still saved.
          </p>
          {backToCart}
        </Outcome>
      );
    case "EXPIRED":
      return (
        <Outcome title="Time ran out" tone="bad">
          <p>
            We didn&apos;t receive your payment in time, so the items were
            released. If M-Pesa still took the money, we&apos;ll confirm the
            order or refund you.
          </p>
          {backToCart}
        </Outcome>
      );
    case "REFUND_PENDING":
      return (
        <Outcome title="We'll refund your payment" tone="bad">
          <p>
            Your payment arrived after the items were sold out. We&apos;ll
            refund {formatKes(order.total)} to your M-Pesa.
          </p>
        </Outcome>
      );
    case "CANCELLED":
      return (
        <Outcome title="Order cancelled" tone="bad">
          {backToCart}
        </Outcome>
      );
  }
}
