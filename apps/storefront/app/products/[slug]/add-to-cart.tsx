"use client";

import type { ProductDetail } from "@soko/shared";
import Link from "next/link";
import { useState } from "react";

import { addToCart } from "@/lib/cart";

export function AddToCart({ product }: { product: ProductDetail }) {
  const [added, setAdded] = useState(false);

  if (product.available === 0) {
    return (
      <button
        disabled
        className="mt-8 rounded-md bg-emerald-700 px-6 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        Sold out
      </button>
    );
  }

  return (
    <div className="mt-8 flex items-center gap-4">
      <button
        onClick={() => {
          addToCart({
            product_id: product.id,
            slug: product.slug,
            title: product.title,
            price: product.price,
          });
          setAdded(true);
        }}
        className="rounded-md bg-emerald-700 px-6 py-3 font-medium text-white hover:bg-emerald-800"
      >
        Add to cart
      </button>
      {added && (
        <p role="status" className="text-sm text-emerald-800">
          Added.{" "}
          <Link href="/cart" className="underline">
            View cart
          </Link>
        </p>
      )}
    </div>
  );
}
