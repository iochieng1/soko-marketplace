import { z } from "zod";

import { paginatedSchema } from "./pagination.js";
import { productSchema, sellerProductSchema } from "./products.js";

export const productListResponseSchema = paginatedSchema(productSchema);
export type ProductListResponse = z.infer<typeof productListResponseSchema>;

export const sellerProductListResponseSchema =
  paginatedSchema(sellerProductSchema);
export type SellerProductListResponse = z.infer<
  typeof sellerProductListResponseSchema
>;

const checkResultSchema = z.enum(["ok", "error"]);

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.object({ db: checkResultSchema, redis: checkResultSchema }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
