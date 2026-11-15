import {
  cartQuoteRequestSchema,
  MAX_ORDER_TOTAL_KES,
  type CartLineIssue,
  type CartQuote,
} from "@soko/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import { inventory, products } from "../db/schema.js";
import { sendError } from "../lib/errors.js";

/**
 * The cart lives on the client (local storage); there is no cart table. Before
 * showing the cart, and again before checkout, the client asks for a quote:
 * current prices and stock straight from the database. Prices the client sends
 * are only compared, never trusted.
 */
const cartRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cart/quote", async (request, reply) => {
    const body = cartQuoteRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    const { items } = body.data;

    // Read-only and unlocked: a quote is advice, not a promise. Stock is only
    // held by checkout, which re-checks everything in its own transaction.
    const rows = await app.db
      .select({
        id: products.id,
        title: products.title,
        slug: products.slug,
        price: products.price,
        available: sql<number>`coalesce(${inventory.onHand} - ${inventory.reserved}, 0)::int`,
      })
      .from(products)
      .leftJoin(inventory, eq(inventory.productId, products.id))
      .where(
        and(
          inArray(
            products.id,
            items.map((i) => i.product_id),
          ),
          // Drafts and archived products are unavailable, like missing ones.
          eq(products.status, "ACTIVE"),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const lines = items.map((item) => {
      const product = byId.get(item.product_id);
      const expected = item.expected_price ?? null;

      if (!product) {
        return {
          product_id: item.product_id,
          quantity: item.quantity,
          title: null,
          slug: null,
          unit_price: null,
          expected_price: expected,
          line_total: 0,
          available: 0,
          issues: ["UNAVAILABLE"] as CartLineIssue[],
        };
      }

      const issues: CartLineIssue[] = [];
      if (product.available === 0) issues.push("OUT_OF_STOCK");
      else if (product.available < item.quantity) {
        issues.push("INSUFFICIENT_STOCK");
      }
      if (expected !== null && expected !== product.price) {
        issues.push("PRICE_CHANGED");
      }

      return {
        product_id: item.product_id,
        quantity: item.quantity,
        title: product.title,
        slug: product.slug,
        unit_price: product.price,
        expected_price: expected,
        line_total: product.price * item.quantity,
        available: product.available,
        issues,
      };
    });

    const total = lines.reduce((sum, line) => sum + line.line_total, 0);
    const blocked = lines.some((line) =>
      line.issues.some((issue) => issue !== "PRICE_CHANGED"),
    );

    const quote: CartQuote = {
      items: lines,
      total,
      currency: "KES",
      can_checkout: !blocked && total <= MAX_ORDER_TOTAL_KES,
    };
    return quote;
  });
};

export default cartRoutes;
