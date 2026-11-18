"use server";

import { type OrderStatusResponse } from "@soko/shared";
import { z } from "zod";

import { fetchOrderStatus } from "@/lib/api";

export type StatusResult =
  { status: OrderStatusResponse } | { notFound: true } | { error: true };

/** Polled by the payment screen. The API URL is server-side config. */
export async function orderStatusAction(
  orderId: unknown,
): Promise<StatusResult> {
  const id = z.uuid().safeParse(orderId);
  if (!id.success) return { notFound: true };
  try {
    const status = await fetchOrderStatus(id.data);
    return status ? { status } : { notFound: true };
  } catch (err) {
    console.error(err);
    return { error: true };
  }
}
