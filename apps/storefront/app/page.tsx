import { formatKes, type ProductListResponse } from "@soko/shared";
import Link from "next/link";
import { connection } from "next/server";

import { fetchProducts } from "@/lib/api";

type PageProps = {
  searchParams: Promise<{ cursor?: string | string[] }>;
};

export default async function ProductsPage({ searchParams }: PageProps) {
  // Render per request: the catalogue must never be baked in at build time.
  await connection();
  const { cursor } = await searchParams;

  let page: ProductListResponse;
  try {
    page = await fetchProducts(typeof cursor === "string" ? cursor : undefined);
  } catch (err) {
    console.error(err);
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-800"
      >
        <h1 className="font-semibold">We couldn&apos;t load products</h1>
        <p className="mt-1 text-sm">
          The shop is having trouble right now. Please try again in a moment.
        </p>
      </div>
    );
  }

  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">Products</h1>

      {page.data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 p-10 text-center text-stone-500">
          No products yet. Check back soon.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {page.data.map((product) => (
            <li
              key={product.id}
              className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm"
            >
              <h2 className="font-medium">{product.title}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-stone-600">
                {product.description}
              </p>
              <p className="mt-3 font-semibold">{formatKes(product.price)}</p>
            </li>
          ))}
        </ul>
      )}

      {page.next_cursor && (
        <div className="mt-8 text-center">
          <Link
            href={{ query: { cursor: page.next_cursor } }}
            className="inline-block rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Next page
          </Link>
        </div>
      )}
    </section>
  );
}
