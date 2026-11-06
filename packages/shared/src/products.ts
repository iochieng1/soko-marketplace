import { z } from "zod";

export const productStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** Public product representation returned by the API (snake_case on the wire). */
export const productSchema = z.object({
  id: z.uuid(),
  seller_id: z.uuid(),
  title: z.string().min(1),
  slug: z.string().min(1),
  description: z.string(),
  // Whole Kenyan shillings. M-Pesa only moves integer amounts, so prices never
  // carry cents and there is no floating-point money anywhere in the system.
  price: z.number().int().positive(),
  currency: z.literal("KES"),
  status: productStatusSchema,
  created_at: z.iso.datetime({ offset: true }),
});
export type Product = z.infer<typeof productSchema>;

export const listProductsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
