import {
  orderSchema,
  orderStatusResponseSchema,
  sellerProductSchema,
  type Order,
} from "@soko/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { inventory, orders, stockReservations } from "../src/db/schema.js";
import { paymentReference } from "../src/lib/payment-sync.js";
import { confirmPayment, failPayment } from "../src/lib/payments.js";
import { type FakePayBridge, startFakePayBridge } from "./fake-paybridge.js";
import {
  buildTestApp,
  createIsolatedDatabase,
  registerSeller,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("M-Pesa payment via PayBridge", () => {
  let paybridge: FakePayBridge;
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    paybridge = await startFakePayBridge({ apiKey: "pk_test_payments" });
    app = await buildTestApp({
      DATABASE_URL: await createIsolatedDatabase(),
      PAYBRIDGE_API_URL: paybridge.url,
      PAYBRIDGE_API_KEY: paybridge.apiKey,
    });
    ({ auth } = await registerSeller(app));
  });

  afterAll(async () => {
    await app.close();
    await paybridge.close();
  });

  beforeEach(() => paybridge.reset());

  const createProduct = async (onHand = 10, price = 1500) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload: {
        title: "Phone case",
        status: "ACTIVE",
        price,
        on_hand: onHand,
      },
    });
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json()).id;
  };

  const checkout = (
    productId: string,
    quantity = 2,
    key = crypto.randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: { "idempotency-key": key },
      payload: {
        customer_email: "akinyi@example.co.ke",
        customer_phone: "0712 345 678",
        items: [{ product_id: productId, quantity }],
      },
    });

  const placeOrder = async (productId: string, quantity = 2) => {
    const res = await checkout(productId, quantity);
    expect(res.statusCode).toBe(201);
    return orderSchema.parse(res.json());
  };

  const pollStatus = async (orderId: string) => {
    // Each poll may reach PayBridge once per sync interval; tests clear the
    // throttle so every poll syncs.
    await app.redis.del(`paybridge:sync:${orderId}`);
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/status`,
    });
    expect(res.statusCode).toBe(200);
    return orderStatusResponseSchema.parse(res.json());
  };

  const row = async (orderId: string) => {
    const [r] = await app.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    return r!;
  };

  const stock = async (productId: string) => {
    const [r] = await app.db
      .select({ onHand: inventory.onHand, reserved: inventory.reserved })
      .from(inventory)
      .where(eq(inventory.productId, productId));
    return r!;
  };

  const holds = async (orderId: string) =>
    (
      await app.db
        .select({ status: stockReservations.status })
        .from(stockReservations)
        .where(eq(stockReservations.orderId, orderId))
    ).map((r) => r.status);

  const paymentIdOf = async (order: Order) => {
    const id = (await row(order.id)).paybridgePaymentId;
    expect(id).toBeTruthy();
    return id!;
  };

  describe("on checkout", () => {
    it("requests an STK push keyed on the order id and stores the payment id", async () => {
      const product = await createProduct();
      const order = await placeOrder(product, 2);

      expect(order.status).toBe("PENDING_PAYMENT");
      const [create] = paybridge.creates();
      expect(paybridge.creates()).toHaveLength(1);
      expect(create!.headers["idempotency-key"]).toBe(order.id);
      expect(create!.headers.authorization).toBe(`Bearer ${paybridge.apiKey}`);
      expect(create!.body).toEqual({
        phone: "254712345678",
        amount: 3000,
        reference: paymentReference(order.id),
        description: "Soko order",
      });
      expect(paymentReference(order.id)).toHaveLength(12);

      const paymentId = await paymentIdOf(order);
      expect(paybridge.payment(paymentId)).toMatchObject({ amount: 3000 });
      expect(await stock(product)).toEqual({ onHand: 10, reserved: 2 });
    });

    it("doesn't request a second payment when checkout is retried", async () => {
      const product = await createProduct();
      const key = crypto.randomUUID();
      const first = await checkout(product, 1, key);
      const retry = await checkout(product, 1, key);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(paybridge.creates()).toHaveLength(1);
    });

    it("releases the stock at once when M-Pesa rejects the push", async () => {
      const product = await createProduct(5);
      paybridge.onCreate((req) => ({
        status: 502,
        body: {
          id: "11111111-2222-4333-8444-555555555555",
          status: "FAILED",
          amount: (req.body as { amount: number }).amount,
          result_desc: "Invalid PhoneNumber",
        },
      }));

      const order = await placeOrder(product, 3);

      expect(order.status).toBe("PAYMENT_FAILED");
      expect((await row(order.id)).paybridgePaymentId).toBe(
        "11111111-2222-4333-8444-555555555555",
      );
      expect(await stock(product)).toEqual({ onHand: 5, reserved: 0 });
      expect(await holds(order.id)).toEqual(["RELEASED"]);
    });

    it("releases the stock when PayBridge refuses the request outright", async () => {
      const product = await createProduct(5);
      paybridge.onCreate(() => ({
        status: 400,
        body: { statusCode: 400, error: "Bad Request", message: "bad phone" },
      }));

      const order = await placeOrder(product, 1);

      expect(order.status).toBe("PAYMENT_FAILED");
      expect(await stock(product)).toEqual({ onHand: 5, reserved: 0 });
    });

    it.each([
      ["a 503", { status: 503, body: { message: "down" } }],
      ["a 429", { status: 429, body: { message: "slow down" } }],
      ["a 409 (key in progress)", { status: 409, body: { message: "wait" } }],
    ] as const)(
      "keeps the order and its stock when PayBridge answers %s",
      async (_name, reply) => {
        const product = await createProduct(5);
        paybridge.onCreate(() => reply);

        const order = await placeOrder(product, 1);

        expect(order.status).toBe("PENDING_PAYMENT");
        expect((await row(order.id)).paybridgePaymentId).toBeNull();
        expect(await stock(product)).toEqual({ onHand: 5, reserved: 1 });
      },
    );

    it("asks again on the next status poll once PayBridge is back", async () => {
      const product = await createProduct();
      paybridge.onCreate(() => ({ status: 503, body: { message: "down" } }));
      const order = await placeOrder(product, 1);
      paybridge.onCreate(undefined);

      const status = await pollStatus(order.id);

      expect(status.status).toBe("PENDING_PAYMENT");
      expect(paybridge.creates()).toHaveLength(2);
      expect(paybridge.creates()[1]!.headers["idempotency-key"]).toBe(order.id);
      await paymentIdOf(order);
    });

    it("asks again when the customer retries checkout", async () => {
      const product = await createProduct();
      const key = crypto.randomUUID();
      paybridge.onCreate(() => ({ status: 503, body: { message: "down" } }));
      await checkout(product, 1, key);
      paybridge.onCreate(undefined);

      const retry = await checkout(product, 1, key);

      expect(retry.statusCode).toBe(200);
      const order = orderSchema.parse(retry.json());
      await paymentIdOf(order);
      expect(await stock(product)).toEqual({ onHand: 10, reserved: 1 });
    });
  });

  describe("GET /v1/orders/:id/status", () => {
    it("returns the status without customer details", async () => {
      const order = await placeOrder(await createProduct(), 1);

      const res = await app.inject({
        method: "GET",
        url: `/v1/orders/${order.id}/status`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: order.id,
        status: "PENDING_PAYMENT",
        total: 1500,
        currency: "KES",
        reserved_until: order.reserved_until,
      });
    });

    it("returns 404 for an unknown or malformed id", async () => {
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        const res = await app.inject({
          method: "GET",
          url: `/v1/orders/${id}/status`,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe("ORDER_NOT_FOUND");
      }
    });

    it("marks the order paid and consumes the stock once the payment succeeds", async () => {
      const product = await createProduct(10);
      const order = await placeOrder(product, 2);
      paybridge.settle(await paymentIdOf(order), "SUCCEEDED");

      expect((await pollStatus(order.id)).status).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 8, reserved: 0 });
      expect(await holds(order.id)).toEqual(["CONSUMED"]);
    });

    it.each(["FAILED", "CANCELLED", "TIMED_OUT"] as const)(
      "releases the stock reservation when the payment is %s",
      async (paymentStatus) => {
        const product = await createProduct(4);
        const order = await placeOrder(product, 3);
        expect(await stock(product)).toEqual({ onHand: 4, reserved: 3 });
        paybridge.settle(await paymentIdOf(order), paymentStatus, {
          result_desc: "Request cancelled by user",
        });

        expect((await pollStatus(order.id)).status).toBe("PAYMENT_FAILED");
        expect(await stock(product)).toEqual({ onHand: 4, reserved: 0 });
        expect(await holds(order.id)).toEqual(["RELEASED"]);

        // The stock is back on sale.
        expect((await checkout(product, 4)).statusCode).toBe(201);
      },
    );

    it("releases the stock only once, however often it's polled", async () => {
      const product = await createProduct(4);
      const order = await placeOrder(product, 2);
      paybridge.settle(await paymentIdOf(order), "CANCELLED");

      await Promise.all(Array.from({ length: 5 }, () => pollStatus(order.id)));
      await pollStatus(order.id);

      expect(await stock(product)).toEqual({ onHand: 4, reserved: 0 });
    });

    it("leaves a pending payment alone", async () => {
      const product = await createProduct();
      const order = await placeOrder(product, 1);

      expect((await pollStatus(order.id)).status).toBe("PENDING_PAYMENT");
      expect(paybridge.lookups()).toHaveLength(1);
      expect(await stock(product)).toEqual({ onHand: 10, reserved: 1 });
    });

    it("doesn't mark the order paid if the amount paid differs", async () => {
      const product = await createProduct();
      const order = await placeOrder(product, 1);
      paybridge.settle(await paymentIdOf(order), "SUCCEEDED", { amount: 1 });

      expect((await pollStatus(order.id)).status).toBe("PENDING_PAYMENT");
      expect(await stock(product)).toEqual({ onHand: 10, reserved: 1 });
      expect((await row(order.id)).flaggedReason).toMatch(/KES 1, but/);
    });

    it("looks the payment up at most once per sync interval", async () => {
      const order = await placeOrder(await createProduct(), 1);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({ method: "GET", url: `/v1/orders/${order.id}/status` }),
        ),
      );

      expect(paybridge.lookups()).toHaveLength(1);
    });

    it("stops looking once the order is settled", async () => {
      const order = await placeOrder(await createProduct(), 1);
      paybridge.settle(await paymentIdOf(order), "SUCCEEDED");
      await pollStatus(order.id);
      paybridge.reset();

      expect((await pollStatus(order.id)).status).toBe("PAID");
      expect(paybridge.requests).toHaveLength(0);
    });

    it("still answers when PayBridge can't be reached", async () => {
      const order = await placeOrder(await createProduct(), 1);
      const down = await buildTestApp({
        DATABASE_URL: app.config.DATABASE_URL,
        // Nothing listens on port 9 (discard) on 127.0.0.1.
        PAYBRIDGE_API_URL: "http://127.0.0.1:9",
        PAYBRIDGE_API_KEY: paybridge.apiKey,
      });
      try {
        const res = await down.inject({
          method: "GET",
          url: `/v1/orders/${order.id}/status`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("PENDING_PAYMENT");
      } finally {
        await down.close();
      }
    });
  });

  describe("failPayment", () => {
    it("leaves a paid order paid", async () => {
      const product = await createProduct();
      const order = await placeOrder(product, 1);
      await confirmPayment(app.db, order.id);

      expect(await failPayment(app.db, order.id)).toBe("ALREADY_SETTLED");
      expect((await row(order.id)).status).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 9, reserved: 0 });
    });

    it("returns undefined for an unknown order", async () => {
      expect(await failPayment(app.db, crypto.randomUUID())).toBeUndefined();
    });

    it("lets a payment that succeeds after all re-take the stock", async () => {
      const product = await createProduct(3);
      const order = await placeOrder(product, 2);
      await failPayment(app.db, order.id);

      expect(await confirmPayment(app.db, order.id)).toBe("PAID_LATE");
      expect(await stock(product)).toEqual({ onHand: 1, reserved: 0 });
    });
  });
});
