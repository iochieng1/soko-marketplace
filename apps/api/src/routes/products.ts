import {
  listProductsQuerySchema,
  type ErrorResponse,
  type ProductListResponse,
} from "@soko/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import { products } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";

const badRequest = (message: string, details?: unknown): ErrorResponse => ({
  error: { code: "BAD_REQUEST", message, details },
});

const productRoutes: FastifyPluginAsync = async (app) => {
  // Public catalogue: ACTIVE products only, newest first, keyset-paginated.
  app.get("/products", async (request, reply) => {
    const query = listProductsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(badRequest("Invalid query parameters", query.error.issues));
    }
    const { limit, cursor: rawCursor } = query.data;

    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return reply.code(400).send(badRequest("Invalid cursor"));
    }

    // Fetch one extra row to learn whether another page exists.
    const rows = await app.db
      .select({
        id: products.id,
        sellerId: products.sellerId,
        title: products.title,
        slug: products.slug,
        description: products.description,
        price: products.price,
        status: products.status,
        createdAt: products.createdAt,
        createdAtText: sql<string>`${products.createdAt}::text`,
      })
      .from(products)
      .where(
        and(
          eq(products.status, "ACTIVE"),
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
      data: page.map((p) => ({
        id: p.id,
        seller_id: p.sellerId,
        title: p.title,
        slug: p.slug,
        description: p.description,
        price: p.price,
        currency: "KES",
        status: p.status,
        created_at: p.createdAt.toISOString(),
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAtText, id: last.id })
          : null,
    };

    return body;
  });
};

export default productRoutes;
