import type { Seller, SellerProductListResponse } from "@soko/shared";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState, ErrorState } from "@/app/components";
import { ApiError, fetchMe, fetchSellerProducts } from "@/lib/api";
import { getAccessToken } from "@/lib/session";

import { logoutAction } from "../actions";
import { NewProductForm, ProductRow } from "../forms";

type PageProps = { searchParams: Promise<{ cursor?: string | string[] }> };

export default async function SellerProductsPage({ searchParams }: PageProps) {
  // proxy.ts has already refreshed the access cookie if it could.
  const token = await getAccessToken();
  if (!token) redirect("/seller/login");
  const { cursor } = await searchParams;

  let seller: Seller;
  let page: SellerProductListResponse;
  try {
    [seller, page] = await Promise.all([
      fetchMe(token),
      fetchSellerProducts(
        token,
        typeof cursor === "string" ? cursor : undefined,
      ),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect("/seller/login");
    }
    console.error(err);
    return <ErrorState title="We couldn't load your products" />;
  }

  return (
    <section className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your products</h1>
          <p className="text-sm text-stone-600">{seller.name}</p>
        </div>
        <form action={logoutAction}>
          <button className="text-sm text-stone-600 hover:underline">
            Log out
          </button>
        </form>
      </div>

      <div>
        <h2 className="mb-3 font-medium">Add a product</h2>
        <NewProductForm />
      </div>

      {page.data.length === 0 ? (
        <EmptyState>No products yet. Add your first one above.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white p-4">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-stone-500">
              <tr>
                <th className="pb-2 font-medium">Product</th>
                <th className="pb-2 font-medium" colSpan={4}>
                  Price, stock and status
                </th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((product) => (
                <ProductRow
                  // Re-mount after a save so inputs show the stored values.
                  key={`${product.id}:${product.updated_at}`}
                  product={product}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page.next_cursor && (
        <div className="text-center">
          <Link
            href={{ query: { cursor: page.next_cursor } }}
            className="text-sm text-emerald-800 underline"
          >
            More products
          </Link>
        </div>
      )}
    </section>
  );
}
