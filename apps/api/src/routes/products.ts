import {
  listProductsQuerySchema,
  type ProductDetail,
  type ProductListResponse,
} from "@soko/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import { inventory, products } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { sendError } from "../lib/errors.js";
import { toProduct } from "../lib/product-mapper.js";

/** Escapes LIKE wildcards so a search for "100%" means the literal text. */
const likeEscape = (value: string) => value.replace(/[\\%_]/g, "\\$&");

const productRoutes: FastifyPluginAsync = async (app) => {
  // Public catalogue: ACTIVE products only, newest first, keyset-paginated.
  app.get("/products", async (request, reply) => {
    const query = listProductsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid query parameters",
        query.error.issues,
      );
    }
    const { limit, cursor: rawCursor, q } = query.data;

    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return sendError(reply, 400, "BAD_REQUEST", "Invalid cursor");
    }

    // Fetch one extra row to learn whether another page exists.
    const rows = await app.db
      .select({
        product: products,
        createdAtText: sql<string>`${products.createdAt}::text`,
      })
      .from(products)
      .where(
        and(
          eq(products.status, "ACTIVE"),
          q ? sql`${products.title} ilike ${`%${likeEscape(q)}%`}` : undefined,
          cursor
            ? sql`(${products.createdAt}, ${products.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit;

    const body: ProductListResponse = {
      data: page.map((r) => toProduct(r.product)),
      next_cursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAtText, id: last.product.id })
          : null,
    };

    return body;
  });

  app.get<{ Params: { slug: string } }>(
    "/products/:slug",
    async (request, reply) => {
      const [row] = await app.db
        .select({
          product: products,
          available: sql<number>`coalesce(${inventory.onHand} - ${inventory.reserved}, 0)::int`,
        })
        .from(products)
        .leftJoin(inventory, eq(inventory.productId, products.id))
        .where(
          and(
            eq(products.slug, request.params.slug),
            // Drafts and archived products 404 exactly like missing ones.
            eq(products.status, "ACTIVE"),
          ),
        );

      if (!row) {
        return sendError(reply, 404, "NOT_FOUND", "Product not found");
      }

      const body: ProductDetail = {
        ...toProduct(row.product),
        available: row.available,
      };
      return body;
    },
  );
};

export default productRoutes;
