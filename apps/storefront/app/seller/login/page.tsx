import Link from "next/link";

import { LoginForm } from "../forms";

type PageProps = { searchParams: Promise<{ next?: string | string[] }> };

export default async function LoginPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  return (
    <section className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold">Seller log in</h1>
      <LoginForm next={typeof next === "string" ? next : undefined} />
      <p className="mt-6 text-sm text-stone-600">
        New to Soko?{" "}
        <Link href="/seller/register" className="text-emerald-800 underline">
          Open a shop
        </Link>
      </p>
    </section>
  );
}
