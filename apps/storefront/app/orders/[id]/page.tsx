import type { OrderStatusResponse } from "@soko/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { ErrorState } from "@/app/components";
import { fetchOrderStatus } from "@/lib/api";

import { PaymentStatus } from "./payment-status";

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Your order · Soko",
  // The URL is the only key to the order: keep it out of search engines.
  robots: { index: false },
};

export default async function OrderPage({ params }: PageProps) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  let status: OrderStatusResponse | null;
  try {
    status = await fetchOrderStatus(id);
  } catch (err) {
    console.error(err);
    return <ErrorState title="We couldn't load your order" />;
  }
  if (!status) notFound();

  return (
    <section className="mx-auto max-w-md">
      <PaymentStatus initial={status} />
    </section>
  );
}
