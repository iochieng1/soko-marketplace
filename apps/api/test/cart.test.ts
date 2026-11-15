import { cartQuoteSchema, sellerProductSchema } from "@soko/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import {
  buildTestApp,
  createIsolatedDatabase,
  registerSeller,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("POST /v1/cart/quote", () => {
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp({ DATABASE_URL: await createIsolatedDatabase() });
    ({ auth } = await registerSeller(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const createProduct = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload: { title: "Cart product", status: "ACTIVE", ...payload },
    });
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json());
  };

  const quote = (items: unknown) =>
    app.inject({ method: "POST", url: "/v1/cart/quote", payload: { items } });

  it("prices the cart from the database and totals it", async () => {
    const kikoy = await createProduct({ price: 1500, on_hand: 10 });
    const coffee = await createProduct({ price: 1800, on_hand: 3 });

    const res = await quote([
      { product_id: kikoy.id, quantity: 2, expected_price: 1500 },
      { product_id: coffee.id, quantity: 1 },
    ]);

    expect(res.statusCode).toBe(200);
    const body = cartQuoteSchema.parse(res.json());
    expect(body).toMatchObject({
      total: 2 * 1500 + 1800,
      currency: "KES",
      can_checkout: true,
    });
    expect(body.items).toEqual([
      expect.objectContaining({
        product_id: kikoy.id,
        unit_price: 1500,
        line_total: 3000,
        available: 10,
        issues: [],
      }),
      expect.objectContaining({
        product_id: coffee.id,
        unit_price: 1800,
        expected_price: null,
        issues: [],
      }),
    ]);
  });

  it("flags a price change but still allows checkout at the new price", async () => {
    const product = await createProduct({ price: 900, on_hand: 5 });

    // The client claims the old (lower) price: it is reported, not used.
    const body = cartQuoteSchema.parse(
      (
        await quote([
          { product_id: product.id, quantity: 2, expected_price: 500 },
        ])
      ).json(),
    );

    expect(body.items[0]).toMatchObject({
      unit_price: 900,
      expected_price: 500,
      line_total: 1800,
      issues: ["PRICE_CHANGED"],
    });
    expect(body.total).toBe(1800);
    expect(body.can_checkout).toBe(true);
  });

  it("flags out-of-stock and short-stock lines and blocks checkout", async () => {
    const soldOut = await createProduct({ price: 100, on_hand: 0 });
    const scarce = await createProduct({ price: 200, on_hand: 2 });

    const body = cartQuoteSchema.parse(
      (
        await quote([
          { product_id: soldOut.id, quantity: 1 },
          { product_id: scarce.id, quantity: 3 },
        ])
      ).json(),
    );

    expect(body.items.map((i) => i.issues)).toEqual([
      ["OUT_OF_STOCK"],
      ["INSUFFICIENT_STOCK"],
    ]);
    expect(body.items[1]?.available).toBe(2);
    expect(body.can_checkout).toBe(false);
  });

  it("marks missing, draft and archived products UNAVAILABLE", async () => {
    const draft = await createProduct({ price: 100, status: "DRAFT" });
    const archived = await createProduct({ price: 100, on_hand: 4 });
    await app.inject({
      method: "PATCH",
      url: `/v1/seller/products/${archived.id}`,
      headers: auth,
      payload: { status: "ARCHIVED" },
    });

    const body = cartQuoteSchema.parse(
      (
        await quote([
          { product_id: draft.id, quantity: 1 },
          { product_id: archived.id, quantity: 1 },
          { product_id: crypto.randomUUID(), quantity: 1 },
        ])
      ).json(),
    );

    for (const line of body.items) {
      expect(line).toMatchObject({
        title: null,
        unit_price: null,
        line_total: 0,
        issues: ["UNAVAILABLE"],
      });
    }
    expect(body.total).toBe(0);
    expect(body.can_checkout).toBe(false);
  });

  it("blocks checkout when the total is over the M-Pesa limit", async () => {
    const pricey = await createProduct({ price: 200_000, on_hand: 5 });

    const body = cartQuoteSchema.parse(
      (await quote([{ product_id: pricey.id, quantity: 2 }])).json(),
    );

    expect(body.items[0]?.issues).toEqual([]);
    expect(body.total).toBe(400_000);
    expect(body.can_checkout).toBe(false);
  });

  it.each([
    ["an empty cart", []],
    ["a zero quantity", [{ product_id: crypto.randomUUID(), quantity: 0 }]],
    [
      "a fractional quantity",
      [{ product_id: crypto.randomUUID(), quantity: 1.5 }],
    ],
    ["a malformed id", [{ product_id: "not-a-uuid", quantity: 1 }]],
  ])("rejects %s with 400", async (_name, items) => {
    const res = await quote(items);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects the same product twice, even in different letter case", async () => {
    const id = crypto.randomUUID();
    const res = await quote([
      { product_id: id, quantity: 1 },
      { product_id: id.toUpperCase(), quantity: 2 },
    ]);
    expect(res.statusCode).toBe(400);
  });
});
