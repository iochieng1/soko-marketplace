import { randomUUID } from "node:crypto";

import {
  sellerProductListResponseSchema,
  sellerProductSchema,
} from "@soko/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { inventory } from "../src/db/schema.js";
import { buildTestApp, registerSeller } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type Auth = { authorization: string };

// Shares the database with products.test.ts, which asserts on the exact
// public catalogue. Everything here stays DRAFT or ARCHIVED so it never shows
// up there; public visibility is tested at the end of products.test.ts.
describe("seller product API", () => {
  let app: App;
  let alice: Auth;
  let bob: Auth;

  beforeAll(async () => {
    app = await buildTestApp();
    alice = (await registerSeller(app)).auth;
    bob = (await registerSeller(app)).auth;
  });

  afterAll(async () => {
    await app.close();
  });

  const create = (auth: Auth, payload: object) =>
    app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload,
    });

  const patch = (auth: Auth, id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/v1/seller/products/${id}`,
      headers: auth,
      payload,
    });

  const get = (auth: Auth, id: string) =>
    app.inject({
      method: "GET",
      url: `/v1/seller/products/${id}`,
      headers: auth,
    });

  const createOk = async (auth: Auth, payload: object) => {
    const res = await create(auth, payload);
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json());
  };

  it.each([
    ["GET", "/v1/seller/products"],
    ["POST", "/v1/seller/products"],
    ["GET", `/v1/seller/products/${randomUUID()}`],
    ["PATCH", `/v1/seller/products/${randomUUID()}`],
  ] as const)("%s %s requires a token", async (method, url) => {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("creates a DRAFT product with stock and a slug from the title", async () => {
    const title = `Kikoy Beach Wrap ${randomUUID().slice(0, 8)}`;
    const product = await createOk(alice, {
      title,
      description: "Hand-woven",
      price: 1500,
      on_hand: 12,
    });

    expect(product).toMatchObject({
      title,
      slug: `kikoy-beach-wrap-${title.slice(-8).toLowerCase()}`,
      status: "DRAFT",
      price: 1500,
      currency: "KES",
      on_hand: 12,
      reserved: 0,
      available: 12,
    });
  });

  it("gives a second product with the same title a different slug", async () => {
    const title = `Maasai Shuka ${randomUUID().slice(0, 8)}`;
    const first = await createOk(alice, { title, price: 1200 });
    const second = await createOk(bob, { title, price: 1100 });

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toMatch(new RegExp(`^${first.slug}-[0-9a-z]{6}$`));
  });

  it("keeps slugs unique when many identical titles are created at once", async () => {
    const title = `Sisal Kiondo ${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => create(alice, { title, price: 2500 })),
    );

    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(201));
    const slugs = results.map((r) => sellerProductSchema.parse(r.json()).slug);
    expect(new Set(slugs).size).toBe(6);
  });

  it.each([
    ["no title", { price: 100 }],
    ["a zero price", { title: "x", price: 0 }],
    ["a fractional price", { title: "x", price: 9.5 }],
    ["negative stock", { title: "x", price: 100, on_hand: -1 }],
    ["status ARCHIVED", { title: "x", price: 100, status: "ARCHIVED" }],
  ])("rejects a create with %s (400)", async (_label, payload) => {
    const res = await create(alice, payload);
    expect(res.statusCode).toBe(400);
  });

  it("lists only the caller's own products", async () => {
    const mine = await createOk(alice, { title: "Alice only", price: 100 });
    const theirs = await createOk(bob, { title: "Bob only", price: 100 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/seller/products?limit=100",
      headers: alice,
    });

    expect(res.statusCode).toBe(200);
    const ids = sellerProductListResponseSchema
      .parse(res.json())
      .data.map((p) => p.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  describe("another seller's product", () => {
    it("can't be read, edited or restocked (404)", async () => {
      const product = await createOk(alice, {
        title: "Not yours",
        price: 500,
        on_hand: 3,
      });

      expect((await get(bob, product.id)).statusCode).toBe(404);
      for (const body of [
        { title: "Stolen" },
        { price: 1 },
        { status: "ARCHIVED" },
        { on_hand: 0 },
      ]) {
        const res = await patch(bob, product.id, body);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      }

      // Nothing changed.
      expect(
        sellerProductSchema.parse((await get(alice, product.id)).json()),
      ).toMatchObject({
        title: "Not yours",
        price: 500,
        status: "DRAFT",
        on_hand: 3,
      });
    });

    it("looks the same as one that doesn't exist", async () => {
      const product = await createOk(alice, { title: "Hidden", price: 500 });

      const foreign = await get(bob, product.id);
      const missing = await get(bob, randomUUID());

      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual(missing.json());
    });
  });

  it("404s on an id that isn't a uuid", async () => {
    expect((await get(alice, "not-a-uuid")).statusCode).toBe(404);
    expect((await patch(alice, "not-a-uuid", { price: 1 })).statusCode).toBe(
      404,
    );
  });

  it("updates fields but keeps the slug so shared links still work", async () => {
    const product = await createOk(alice, { title: "Old name", price: 100 });

    const res = await patch(alice, product.id, {
      title: "New name",
      description: "Now with a description",
      price: 150,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: "New name",
      description: "Now with a description",
      price: 150,
      slug: product.slug,
    });
  });

  it("rejects an empty update (400)", async () => {
    const product = await createOk(alice, { title: "Empty patch", price: 100 });
    expect((await patch(alice, product.id, {})).statusCode).toBe(400);
  });

  it("archives a product", async () => {
    const product = await createOk(alice, { title: "Retired", price: 100 });

    const res = await patch(alice, product.id, { status: "ARCHIVED" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ARCHIVED" });
  });

  describe("stock", () => {
    it("sets on_hand and bumps the inventory version", async () => {
      const product = await createOk(alice, {
        title: "Restock me",
        price: 100,
        on_hand: 2,
      });

      const res = await patch(alice, product.id, { on_hand: 40 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ on_hand: 40, available: 40 });
      const [row] = await app.db
        .select({ version: inventory.version })
        .from(inventory)
        .where(eq(inventory.productId, product.id));
      expect(row?.version).toBe(1);
    });

    it("rejects lowering on_hand below reserved via the DB constraint (409)", async () => {
      const product = await createOk(alice, {
        title: "Half sold",
        price: 100,
        on_hand: 10,
      });
      // Simulate unpaid checkouts holding 6 units.
      await app.db
        .update(inventory)
        .set({ reserved: 6 })
        .where(eq(inventory.productId, product.id));

      const res = await patch(alice, product.id, {
        on_hand: 5,
        price: 999, // in the same request: must roll back with the stock change
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "STOCK_BELOW_RESERVED" },
      });
      expect(
        sellerProductSchema.parse((await get(alice, product.id)).json()),
      ).toMatchObject({ on_hand: 10, reserved: 6, available: 4, price: 100 });

      // Exactly the reserved amount is fine.
      const ok = await patch(alice, product.id, { on_hand: 6 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ on_hand: 6, available: 0 });
    });
  });
});
