import { productListResponseSchema } from "@soko/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { seedDatabase } from "../src/db/seed.js";
import { buildTestApp } from "./helpers.js";

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
});
