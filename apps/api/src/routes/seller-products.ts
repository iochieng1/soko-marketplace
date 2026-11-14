import {
  createProductRequestSchema,
  listSellerProductsQuerySchema,
  updateProductRequestSchema,
  type SellerProduct,
  type SellerProductListResponse,
} from "@soko/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import { requireSeller } from "../auth/authenticate.js";
import type { Database } from "../db/client.js";
import { inventory, products } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import {
  isCheckViolation,
  isUniqueViolation,
  isUuid,
  sendError,
} from "../lib/errors.js";
import { toProduct } from "../lib/product-mapper.js";
import { slugify, withSuffix } from "../lib/slug.js";

const sellerProductColumns = {
  product: products,
  onHand: sql<number>`coalesce(${inventory.onHand}, 0)::int`,
  reserved: sql<number>`coalesce(${inventory.reserved}, 0)::int`,
  createdAtText: sql<string>`${products.createdAt}::text`,
};

type SellerProductRow = {
  product: typeof products.$inferSelect;
  onHand: number;
  reserved: number;
};

const toSellerProduct = (row: SellerProductRow): SellerProduct => ({
  ...toProduct(row.product),
  on_hand: row.onHand,
  reserved: row.reserved,
  available: row.onHand - row.reserved,
  updated_at: row.product.updatedAt.toISOString(),
});

/**
 * Every query here is scoped by seller_id. Another seller's product is
 * indistinguishable from one that doesn't exist (404, not 403), so ids can't
 * be probed to discover what other sellers have.
 */
const findOwned = async (db: Database, sellerId: string, id: string) => {
  const [row] = await db
    .select(sellerProductColumns)
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(and(eq(products.id, id), eq(products.sellerId, sellerId)));
  return row;
};

class StockBelowReservedError extends Error {}

const sellerProductRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", requireSeller);

  app.get("/seller/products", async (request, reply) => {
    const query = listSellerProductsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid query parameters",
        query.error.issues,
      );
    }
    const { limit, cursor: rawCursor } = query.data;
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return sendError(reply, 400, "BAD_REQUEST", "Invalid cursor");
    }

    const rows = await app.db
      .select(sellerProductColumns)
      .from(products)
      .leftJoin(inventory, eq(inventory.productId, products.id))
      .where(
        and(
          eq(products.sellerId, request.sellerId),
          cursor
            ? sql`(${products.createdAt}, ${products.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const body: SellerProductListResponse = {
      data: page.map(toSellerProduct),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAtText, id: last.product.id })
          : null,
    };
    return body;
  });

  app.get<{ Params: { id: string } }>(
    "/seller/products/:id",
    async (request, reply) => {
      const { id } = request.params;
      const row = isUuid(id)
        ? await findOwned(app.db, request.sellerId, id)
        : undefined;
      if (!row) return sendError(reply, 404, "NOT_FOUND", "Product not found");
      return toSellerProduct(row);
    },
  );

  app.post("/seller/products", async (request, reply) => {
    const body = createProductRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    const { title, description, price, status, on_hand } = body.data;
    const baseSlug = slugify(title);

    // Slugs are unique. Try the clean slug first; if another product has it,
    // retry with a random suffix. The unique constraint decides, not a
    // SELECT beforehand, so two sellers creating "Kikoy" at once can't both
    // get "kikoy".
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? baseSlug : withSuffix(baseSlug);
      try {
        const id = await app.db.transaction(async (tx) => {
          const [product] = await tx
            .insert(products)
            .values({
              sellerId: request.sellerId,
              title,
              slug,
              description,
              price,
              status,
            })
            .returning({ id: products.id });
          if (!product) throw new Error("Product insert returned no row");
          await tx
            .insert(inventory)
            .values({ productId: product.id, onHand: on_hand });
          return product.id;
        });

        const row = await findOwned(app.db, request.sellerId, id);
        if (!row) throw new Error("Created product not found");
        return reply.code(201).send(toSellerProduct(row));
      } catch (err) {
        if (isUniqueViolation(err, "products_slug_unique")) continue;
        throw err;
      }
    }
    throw new Error(`Could not find a free slug for "${baseSlug}"`);
  });

  app.patch<{ Params: { id: string } }>(
    "/seller/products/:id",
    async (request, reply) => {
      const { id } = request.params;
      if (!isUuid(id)) {
        return sendError(reply, 404, "NOT_FOUND", "Product not found");
      }
      const body = updateProductRequestSchema.safeParse(request.body);
      if (!body.success) {
        return sendError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid request body",
          body.error.issues,
        );
      }
      const { on_hand, ...fields } = body.data;

      let found: boolean;
      try {
        found = await app.db.transaction(async (tx) => {
          // The slug is deliberately not regenerated from a new title: links
          // people have already shared keep working.
          const updated = await tx
            .update(products)
            .set({ ...fields, updatedAt: sql`now()` })
            .where(
              and(eq(products.id, id), eq(products.sellerId, request.sellerId)),
            )
            .returning({ id: products.id });
          if (updated.length === 0) return false;

          if (on_hand !== undefined) {
            try {
              // No pre-check against `reserved`: the inventory CHECK
              // constraint rejects on_hand < reserved atomically, even if a
              // checkout reserves stock between a read and this write.
              await tx
                .update(inventory)
                .set({
                  onHand: on_hand,
                  version: sql`${inventory.version} + 1`,
                  updatedAt: sql`now()`,
                })
                .where(eq(inventory.productId, id));
            } catch (err) {
              if (isCheckViolation(err, "inventory_reserved_within_on_hand")) {
                throw new StockBelowReservedError();
              }
              throw err;
            }
          }
          return true;
        });
      } catch (err) {
        if (err instanceof StockBelowReservedError) {
          return sendError(
            reply,
            409,
            "STOCK_BELOW_RESERVED",
            "on_hand can't go below the stock reserved by unpaid orders",
          );
        }
        throw err;
      }

      if (!found)
        return sendError(reply, 404, "NOT_FOUND", "Product not found");
      const row = await findOwned(app.db, request.sellerId, id);
      if (!row) return sendError(reply, 404, "NOT_FOUND", "Product not found");
      return toSellerProduct(row);
    },
  );
};

export default sellerProductRoutes;
