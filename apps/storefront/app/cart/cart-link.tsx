"use client";

import Link from "next/link";

import { useCart } from "@/lib/cart";

export function CartLink() {
  const count = useCart().reduce((n, line) => n + line.quantity, 0);
  return (
    <Link
      href="/cart"
      className="text-sm font-medium text-emerald-800 hover:underline"
    >
      Cart{count > 0 && ` (${count})`}
    </Link>
  );
}
