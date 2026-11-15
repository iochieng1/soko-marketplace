import { orderSchema, sellerProductSchema } from "@soko/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { inventory, orders, stockReservations } from "../src/db/schema.js";
import {
  buildTestApp,
  createIsolatedDatabase,
  registerSeller,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const customer = {
  customer_email: "wanjiru@example.co.ke",
  customer_phone: "0712 345 678",
};

describe("POST /v1/checkout", () => {
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp({ DATABASE_URL: await createIsolatedDatabase() });
    ({ auth } = await registerSeller(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const createProduct = async (price: number, onHand: number) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload: {
        title: "Checkout product",
        status: "ACTIVE",
        price,
        on_hand: onHand,
      },
    });
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json());
  };

  const checkout = (
    items: unknown,
    key: string | null = crypto.randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: key === null ? {} : { "idempotency-key": key },
      payload: { ...customer, items, ...extra },
    });

  const stock = async (productId: string) => {
    const [row] = await app.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    return row!;
  };

  const reservationsFor = (productId: string) =>
    app.db
      .select()
      .from(stockReservations)
      .where(eq(stockReservations.productId, productId));

  it("places a PENDING_PAYMENT order, snapshots prices and reserves stock", async () => {
    const a = await createProduct(1500, 10);
    const b = await createProduct(250, 4);
    const before = Date.now();

    const res = await checkout([
      { product_id: a.id, quantity: 2, expected_price: 1500 },
      { product_id: b.id, quantity: 4 },
    ]);

    expect(res.statusCode).toBe(201);
    const order = orderSchema.parse(res.json());
    expect(order).toMatchObject({
      status: "PENDING_PAYMENT",
      customer_email: customer.customer_email,
      // Normalised to the M-Pesa MSISDN format.
      customer_phone: "254712345678",
      total: 2 * 1500 + 4 * 250,
      currency: "KES",
    });
    expect(order.items).toHaveLength(2);
    expect(order.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: a.id,
          quantity: 2,
          unit_price: 1500,
          line_total: 3000,
        }),
        expect.objectContaining({ product_id: b.id, quantity: 4 }),
      ]),
    );

    // Held for ~10 minutes (the default TTL).
    const heldFor = Date.parse(order.reserved_until) - before;
    expect(heldFor).toBeGreaterThan(9 * 60_000);
    expect(heldFor).toBeLessThan(11 * 60_000);

    expect(await stock(a.id)).toMatchObject({ onHand: 10, reserved: 2 });
    expect(await stock(b.id)).toMatchObject({ onHand: 4, reserved: 4 });
    expect(await reservationsFor(a.id)).toEqual([
      expect.objectContaining({
        orderId: order.id,
        quantity: 2,
        status: "ACTIVE",
      }),
    ]);
  });

  it("keeps the price paid even if the seller edits it afterwards", async () => {
    const product = await createProduct(1000, 5);
    const order = orderSchema.parse(
      (await checkout([{ product_id: product.id, quantity: 1 }])).json(),
    );

    await app.inject({
      method: "PATCH",
      url: `/v1/seller/products/${product.id}`,
      headers: auth,
      payload: { price: 9999 },
    });

    const [row] = await app.db
      .select({ total: orders.total })
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(row?.total).toBe(1000);
  });

  it("returns 409 OUT_OF_STOCK and rolls back every line", async () => {
    const plenty = await createProduct(100, 10);
    const scarce = await createProduct(100, 1);

    const res = await checkout([
      { product_id: plenty.id, quantity: 3 },
      { product_id: scarce.id, quantity: 2 },
    ]);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "OUT_OF_STOCK", details: { product_id: scarce.id } },
    });
    // The reservation on the first product was rolled back with the rest.
    expect(await stock(plenty.id)).toMatchObject({ reserved: 0 });
    expect(await reservationsFor(plenty.id)).toEqual([]);
  });

  it("counts stock other orders already hold", async () => {
    const product = await createProduct(100, 3);
    expect(
      (await checkout([{ product_id: product.id, quantity: 2 }])).statusCode,
    ).toBe(201);

    const res = await checkout([{ product_id: product.id, quantity: 2 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "OUT_OF_STOCK" } });
  });

  it("returns 409 PRICE_CHANGED when the expected price is stale", async () => {
    const product = await createProduct(700, 5);

    const res = await checkout([
      { product_id: product.id, quantity: 1, expected_price: 650 },
    ]);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: "PRICE_CHANGED",
        details: { product_id: product.id, unit_price: 700 },
      },
    });
    expect(await stock(product.id)).toMatchObject({ reserved: 0 });
  });

  it("returns 409 PRODUCT_UNAVAILABLE for a product that isn't for sale", async () => {
    const res = await checkout([
      { product_id: crypto.randomUUID(), quantity: 1 },
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "PRODUCT_UNAVAILABLE" },
    });
  });

  it("returns 422 when the total is over the M-Pesa limit", async () => {
    const product = await createProduct(200_000, 5);
    const res = await checkout([{ product_id: product.id, quantity: 2 }]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: "ORDER_TOTAL_TOO_LARGE" },
    });
    expect(await stock(product.id)).toMatchObject({ reserved: 0 });
  });

  it("requires an Idempotency-Key", async () => {
    const product = await createProduct(100, 5);
    for (const key of [null, "short"]) {
      const res = await checkout(
        [{ product_id: product.id, quantity: 1 }],
        key,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
      });
    }
  });

  it("rejects an invalid phone number", async () => {
    const product = await createProduct(100, 5);
    const res = await checkout(
      [{ product_id: product.id, quantity: 1 }],
      crypto.randomUUID(),
      { customer_phone: "12345" },
    );
    expect(res.statusCode).toBe(400);
  });

  describe("idempotency", () => {
    it("returns the same order for a retry and reserves stock only once", async () => {
      const product = await createProduct(500, 5);
      const key = crypto.randomUUID();
      const items = [{ product_id: product.id, quantity: 2 }];

      const first = await checkout(items, key);
      const retry = await checkout(items, key);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json()).toEqual(first.json());
      expect(await stock(product.id)).toMatchObject({ reserved: 2 });
    });

    it("returns one order when retries race each other", async () => {
      const product = await createProduct(500, 50);
      const key = crypto.randomUUID();
      const items = [{ product_id: product.id, quantity: 1 }];

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => checkout(items, key)),
      );

      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([...Array(9).fill(200), 201]);
      const ids = new Set(responses.map((r) => r.json().id));
      expect(ids.size).toBe(1);
      expect(await stock(product.id)).toMatchObject({ reserved: 1 });
    });

    it("refuses to reuse a key for a different order", async () => {
      const product = await createProduct(500, 5);
      const key = crypto.randomUUID();
      await checkout([{ product_id: product.id, quantity: 1 }], key);

      const differentCart = await checkout(
        [{ product_id: product.id, quantity: 2 }],
        key,
      );
      const differentCustomer = await checkout(
        [{ product_id: product.id, quantity: 1 }],
        key,
        { customer_email: "someone-else@example.co.ke" },
      );

      for (const res of [differentCart, differentCustomer]) {
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({
          error: { code: "IDEMPOTENCY_KEY_REUSED" },
        });
      }
      expect(await stock(product.id)).toMatchObject({ reserved: 1 });
    });

    it("lets a key that failed be retried once stock allows", async () => {
      const product = await createProduct(500, 1);
      const key = crypto.randomUUID();
      const items = [{ product_id: product.id, quantity: 2 }];

      expect((await checkout(items, key)).statusCode).toBe(409);
      await app.inject({
        method: "PATCH",
        url: `/v1/seller/products/${product.id}`,
        headers: auth,
        payload: { on_hand: 2 },
      });
      expect((await checkout(items, key)).statusCode).toBe(201);
    });
  });

  describe("under concurrency", () => {
    it("50 parallel checkouts for 10 in stock give exactly 10 orders and 40 409s", async () => {
      const product = await createProduct(1000, 10);

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          checkout([{ product_id: product.id, quantity: 1 }]),
        ),
      );

      const created = responses.filter((r) => r.statusCode === 201);
      const rejected = responses.filter((r) => r.statusCode === 409);
      expect(created).toHaveLength(10);
      expect(rejected).toHaveLength(40);
      for (const res of rejected) {
        expect(res.json()).toMatchObject({ error: { code: "OUT_OF_STOCK" } });
      }

      expect(await stock(product.id)).toMatchObject({
        onHand: 10,
        reserved: 10,
      });
      const holds = await reservationsFor(product.id);
      expect(holds).toHaveLength(10);
      expect(new Set(holds.map((h) => h.orderId))).toEqual(
        new Set(created.map((r) => r.json().id)),
      );
    });

    it("doesn't deadlock when carts list the same products in different orders", async () => {
      const a = await createProduct(100, 100);
      const b = await createProduct(100, 100);
      const c = await createProduct(100, 100);
      const orderings = [
        [a, b, c],
        [c, b, a],
        [b, a, c],
        [c, a, b],
      ];

      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, n) =>
          checkout(
            orderings[n % orderings.length]!.map((p) => ({
              product_id: p.id,
              quantity: 1,
            })),
          ),
        ),
      );

      expect(responses.map((r) => r.statusCode)).toEqual(Array(40).fill(201));
      for (const p of [a, b, c]) {
        expect(await stock(p.id)).toMatchObject({ reserved: 40 });
      }
    });
  });
});
