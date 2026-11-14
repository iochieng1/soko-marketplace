import type { Product } from "@soko/shared";

import type { products } from "../db/schema.js";

type ProductRow = typeof products.$inferSelect;

/** DB row -> public wire format (snake_case, explicit currency). */
export const toProduct = (p: ProductRow): Product => ({
  id: p.id,
  seller_id: p.sellerId,
  title: p.title,
  slug: p.slug,
  description: p.description,
  price: p.price,
  currency: "KES",
  status: p.status,
  created_at: p.createdAt.toISOString(),
});
