import Link from "next/link";

import { EmptyState } from "@/app/components";

export default function ProductNotFound() {
  return (
    <EmptyState>
      <p className="font-medium text-stone-700">
        This product isn&apos;t available.
      </p>
      <p className="mt-1 text-sm">
        It may have sold out or been removed by the seller.
      </p>
      <Link href="/" className="mt-4 inline-block text-emerald-800 underline">
        Browse all products
      </Link>
    </EmptyState>
  );
}
