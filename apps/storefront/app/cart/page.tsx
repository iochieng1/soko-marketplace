import type { Metadata } from "next";

import { CartView } from "./cart-view";

export const metadata: Metadata = { title: "Cart · Soko" };

export default function CartPage() {
  return (
    <section className="max-w-3xl">
      <h1 className="mb-6 text-3xl font-semibold">Your cart</h1>
      <CartView />
    </section>
  );
}
