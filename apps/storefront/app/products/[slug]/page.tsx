import { formatKes, type ProductDetail } from "@soko/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { ErrorState } from "@/app/components";
import { fetchProduct } from "@/lib/api";

type PageProps = { params: Promise<{ slug: string }> };

// generateMetadata and the page both need the product: fetch it once.
const getProduct = cache(fetchProduct);

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug).catch(() => null);
  return product
    ? { title: `${product.title} · Soko`, description: product.description }
    : { title: "Soko" };
}

export default async function ProductPage({ params }: PageProps) {
  await connection();
  const { slug } = await params;

  let product: ProductDetail | null;
  try {
    product = await getProduct(slug);
  } catch (err) {
    console.error(err);
    return <ErrorState title="We couldn't load this product" />;
  }
  if (!product) notFound();

  const inStock = product.available > 0;

  return (
    <article className="max-w-2xl">
      <Link href="/" className="text-sm text-emerald-800 hover:underline">
        ← All products
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">{product.title}</h1>
      <p className="mt-2 text-2xl font-semibold">{formatKes(product.price)}</p>

      <p
        className={`mt-2 text-sm ${inStock ? "text-emerald-800" : "text-red-700"}`}
      >
        {inStock
          ? product.available <= 5
            ? `Only ${product.available} left`
            : "In stock"
          : "Sold out"}
      </p>

      {product.description && (
        <p className="mt-6 whitespace-pre-line text-stone-700">
          {product.description}
        </p>
      )}

      <button
        disabled
        title="M-Pesa checkout is coming soon"
        className="mt-8 rounded-md bg-emerald-700 px-6 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {inStock ? "Pay with M-Pesa (coming soon)" : "Sold out"}
      </button>
    </article>
  );
}
