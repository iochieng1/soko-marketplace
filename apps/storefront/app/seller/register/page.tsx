import Link from "next/link";

import { RegisterForm } from "../forms";

export default function RegisterPage() {
  return (
    <section className="mx-auto max-w-sm">
      <h1 className="mb-2 text-2xl font-semibold">Open a shop on Soko</h1>
      <p className="mb-6 text-sm text-stone-600">
        List your products and get paid by M-Pesa.
      </p>
      <RegisterForm />
      <p className="mt-6 text-sm text-stone-600">
        Already selling?{" "}
        <Link href="/seller/login" className="text-emerald-800 underline">
          Log in
        </Link>
      </p>
    </section>
  );
}
