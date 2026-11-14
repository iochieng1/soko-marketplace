import { formatKes, type ProductListResponse } from "@soko/shared";
import Link from "next/link";
import { connection } from "next/server";

import { fetchProducts } from "@/lib/api";

import { EmptyState, ErrorState } from "./components";

type PageProps = {
  searchParams: Promise<{ cursor?: string | string[]; q?: string | string[] }>;
};

const single = (value: string | string[] | undefined) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export default async function ProductsPage({ searchParams }: PageProps) {
  // Render per request: the catalogue must never be baked in at build time.
  await connection();
  const params = await searchParams;
  const cursor = single(params.cursor);
  const q = single(params.q);

  let page: ProductListResponse;
  try {
    page = await fetchProducts({ cursor, q });
  } catch (err) {
    console.error(err);
    return <ErrorState title="We couldn't load products" />;
  }

  return (
    <section>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">
          {q ? `Results for “${q}”` : "Products"}
        </h1>
        <form action="/" role="search" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search products
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={100}
            placeholder="Search products"
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm sm:w-64"
          />
          <button className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
            Search
          </button>
        </form>
      </div>

      {page.data.length === 0 ? (
        <EmptyState>
          {q ? (
            <>
              Nothing matches “{q}”.{" "}
              <Link href="/" className="text-emerald-800 underline">
                See all products
              </Link>
            </>
          ) : (
            "No products yet. Check back soon."
          )}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {page.data.map((product) => (
            <li key={product.id}>
              <Link
                href={`/products/${product.slug}`}
                className="block h-full rounded-lg border border-stone-200 bg-white p-4 shadow-sm transition hover:border-emerald-600"
              >
                <h2 className="font-medium">{product.title}</h2>
                <p className="mt-1 line-clamp-2 text-sm text-stone-600">
                  {product.description}
                </p>
                <p className="mt-3 font-semibold">{formatKes(product.price)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.next_cursor && (
        <div className="mt-8 text-center">
          <Link
            href={{ query: { ...(q && { q }), cursor: page.next_cursor } }}
            className="inline-block rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Next page
          </Link>
        </div>
      )}
    </section>
  );
}
