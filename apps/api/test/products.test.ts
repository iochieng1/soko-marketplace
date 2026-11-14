import {
  productDetailSchema,
  productListResponseSchema,
  sellerProductSchema,
} from "@soko/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { seedDatabase } from "../src/db/seed.js";
import { buildTestApp, registerSeller } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

// Test files share one database. Other files only ever insert DRAFT products,
// which never appear in this listing, so these assertions stay deterministic.
// Tests within a file run in order, which the steps below rely on.
describe("GET /v1/products", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const list = async (query = "") => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/products${query}`,
    });
    return { res, body: productListResponseSchema.parse(res.json()) };
  };

  it("returns an empty page before anything is seeded", async () => {
    const { res, body } = await list();

    expect(res.statusCode).toBe(200);
    expect(body).toEqual({ data: [], next_cursor: null });
  });

  it("returns seeded ACTIVE products and excludes drafts", async () => {
    const seeded = await seedDatabase(app.db);
    // Seeding is idempotent: a second run must not duplicate anything.
    await seedDatabase(app.db);

    const { res, body } = await list();

    const activeSlugs = seeded
      .filter((p) => p.status === "ACTIVE")
      .map((p) => p.slug);
    expect(res.statusCode).toBe(200);
    expect(body.next_cursor).toBeNull();
    expect(body.data.map((p) => p.slug).sort()).toEqual(activeSlugs.sort());
    expect(body.data.every((p) => p.status === "ACTIVE")).toBe(true);
    expect(body.data.map((p) => p.slug)).not.toContain(
      "soapstone-elephant-carving",
    );
    expect(body.data[0]).toMatchObject({ currency: "KES" });
  });

  it("paginates with an opaque cursor without skipping or repeating rows", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : "?limit=1";
      const { body } = await list(query);
      seen.push(...body.data.map((p) => p.slug));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);

    // All four active products were inserted in one statement, so they share a
    // created_at: this exercises the id tie-breaker in the keyset.
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(4);
  });

  it.each([
    ["limit=0", "?limit=0"],
    ["limit=101", "?limit=101"],
    ["a garbage cursor", "?cursor=not-a-cursor"],
  ])("rejects %s with 400", async (_label, query) => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/products${query}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("searches titles case-insensitively, treating wildcards literally", async () => {
    const coffee = await list("?q=COFFEE");
    expect(coffee.res.statusCode).toBe(200);
    expect(coffee.body.data.map((p) => p.slug)).toEqual([
      "kenya-aa-coffee-500g",
    ]);

    // "%" must not act as a LIKE wildcard that matches everything.
    expect((await list("?q=%25")).body.data).toEqual([]);
    expect((await list("?q=_")).body.data).toEqual([]);
    // Drafts are not searchable either.
    expect((await list("?q=soapstone")).body.data).toEqual([]);
  });

  describe("GET /v1/products/:slug", () => {
    const detail = (slug: string) =>
      app.inject({ method: "GET", url: `/v1/products/${slug}` });

    it("returns an active product with available stock", async () => {
      const res = await detail("sisal-kiondo-basket");

      expect(res.statusCode).toBe(200);
      expect(productDetailSchema.parse(res.json())).toMatchObject({
        slug: "sisal-kiondo-basket",
        price: 2500,
        available: 8,
      });
    });

    it("404s for drafts and for slugs that don't exist", async () => {
      for (const slug of ["soapstone-elephant-carving", "no-such-product"]) {
        const res = await detail(slug);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      }
    });

    it("hides a product from the public API once it's archived", async () => {
      const { auth } = await registerSeller(app);
      const created = await app.inject({
        method: "POST",
        url: "/v1/seller/products",
        headers: auth,
        payload: {
          title: "Lamu dhow model",
          price: 4000,
          status: "ACTIVE",
          on_hand: 1,
        },
      });
      const product = sellerProductSchema.parse(created.json());

      expect((await detail(product.slug)).statusCode).toBe(200);
      expect((await list("?q=dhow")).body.data).toHaveLength(1);

      await app.inject({
        method: "PATCH",
        url: `/v1/seller/products/${product.id}`,
        headers: auth,
        payload: { status: "ARCHIVED" },
      });

      expect((await detail(product.slug)).statusCode).toBe(404);
      expect((await list("?q=dhow")).body.data).toEqual([]);
      expect(
        (await list("?limit=100")).body.data.map((p) => p.id),
      ).not.toContain(product.id);
    });
  });
});
