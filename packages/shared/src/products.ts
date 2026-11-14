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

/** `GET /v1/products/:slug`: a product plus how many can be bought right now. */
export const productDetailSchema = productSchema.extend({
  // on_hand - reserved: stock not held by someone else's unpaid checkout.
  available: z.number().int().nonnegative(),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

/** A product as its own seller sees it, including stock. */
export const sellerProductSchema = productDetailSchema.extend({
  on_hand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type SellerProduct = z.infer<typeof sellerProductSchema>;

export const listProductsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  // Case-insensitive substring match on the title.
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const listSellerProductsQuerySchema = listProductsQuerySchema.omit({
  q: true,
});

// Safaricom caps a single M-Pesa transaction at KES 250,000, so a higher
// price could never be paid.
export const MAX_PRICE_KES = 250_000;
export const MAX_STOCK = 1_000_000;

const titleSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().max(5_000);
const priceSchema = z.coerce.number().int().positive().max(MAX_PRICE_KES);
const onHandSchema = z.coerce.number().int().min(0).max(MAX_STOCK);

export const createProductRequestSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(""),
  price: priceSchema,
  // A product is created as a draft or published straight away. Archiving is
  // only something you do to a product that already exists.
  status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
  on_hand: onHandSchema.default(0),
});
export type CreateProductRequest = z.input<typeof createProductRequestSchema>;

export const updateProductRequestSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    price: priceSchema,
    status: productStatusSchema,
    on_hand: onHandSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });
export type UpdateProductRequest = z.input<typeof updateProductRequestSchema>;
