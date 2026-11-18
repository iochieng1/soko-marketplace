"use client";

import { MAX_CART_ITEMS, MAX_ITEM_QUANTITY } from "@soko/shared";
import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The shopper's cart, kept in local storage (no server-side cart in v1).
 * Everything here is a hint: `price` is what the shopper saw when adding, and
 * is only sent as `expected_price` so the API can flag a change. The API
 * quote decides prices, stock and the total.
 */
const cartLineSchema = z.object({
  product_id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  price: z.number().int().positive(),
  quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY),
});
export type CartLine = z.infer<typeof cartLineSchema>;

const STORAGE_KEY = "soko:cart:v1";
const EMPTY: CartLine[] = [];

let cached: { raw: string | null; lines: CartLine[] } = {
  raw: null,
  lines: EMPTY,
};
const listeners = new Set<() => void>();
// Set once storage refuses a write; the cart then lives in memory only.
let memoryOnly = false;

const read = (): CartLine[] => {
  if (memoryOnly) return cached.lines;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, disabled site data): an empty cart.
  }
  // useSyncExternalStore needs a stable snapshot between changes.
  if (raw === cached.raw) return cached.lines;

  let lines = EMPTY;
  try {
    const parsed = z.array(cartLineSchema).safeParse(JSON.parse(raw ?? "[]"));
    if (parsed.success) lines = parsed.data;
  } catch {
    // Corrupt JSON: start again rather than crash the page.
  }
  cached = { raw, lines };
  return lines;
};

const write = (lines: CartLine[]) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    // Quota or blocked storage: the cart lasts only until reload.
    memoryOnly = true;
    cached = { raw: null, lines };
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Keep tabs in sync: another tab's write fires a storage event here.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

export const useCart = () => useSyncExternalStore(subscribe, read, () => EMPTY);

export const addToCart = (line: Omit<CartLine, "quantity">, quantity = 1) => {
  const lines = read();
  const existing = lines.find((l) => l.product_id === line.product_id);
  if (existing) {
    setQuantity(line.product_id, existing.quantity + quantity);
    return;
  }
  if (lines.length >= MAX_CART_ITEMS) return;
  write([
    ...lines,
    { ...line, quantity: Math.min(quantity, MAX_ITEM_QUANTITY) },
  ]);
};

export const setQuantity = (productId: string, quantity: number) => {
  const q = Math.min(Math.max(Math.trunc(quantity), 0), MAX_ITEM_QUANTITY);
  write(
    q === 0
      ? read().filter((l) => l.product_id !== productId)
      : read().map((l) =>
          l.product_id === productId ? { ...l, quantity: q } : l,
        ),
  );
};

/** Accept the server's current price, so it stops being flagged as changed. */
export const acceptPrice = (productId: string, price: number) => {
  write(read().map((l) => (l.product_id === productId ? { ...l, price } : l)));
};

export const removeFromCart = (productId: string) => setQuantity(productId, 0);

/** Empties the cart, once its order is paid. */
export const clearCart = () => write([]);
