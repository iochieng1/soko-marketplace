import { orderSchema, sellerProductSchema } from "@soko/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import {
  inventory,
  orders,
  outbox,
  processedWebhooks,
  stockReservations,
} from "../src/db/schema.js";
import type { PayBridgeStatus } from "../src/lib/paybridge.js";
import { signWebhook } from "../src/lib/webhook-signature.js";
import { type FakePayBridge, startFakePayBridge } from "./fake-paybridge.js";
import {
  buildTestApp,
  createIsolatedDatabase,
  registerSeller,
  testConfig,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const SECRET = testConfig().PAYBRIDGE_WEBHOOK_SECRET;

describe("POST /v1/webhooks/paybridge", () => {
  let paybridge: FakePayBridge;
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    paybridge = await startFakePayBridge({ apiKey: "pk_test_webhooks" });
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

  const createProduct = async (onHand = 10, price = 1500) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload: {
        title: "Kiondo bag",
        status: "ACTIVE",
        price,
        on_hand: onHand,
      },
    });
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json()).id;
  };

  /** Places an order and returns it with its PayBridge payment id. */
  const placeOrder = async (productId: string, quantity = 2) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        customer_email: "wanjiru@example.co.ke",
        customer_phone: "0712 345 678",
        items: [{ product_id: productId, quantity }],
      },
    });
    expect(res.statusCode).toBe(201);
    const order = orderSchema.parse(res.json());
    const [r] = await app.db
      .select({ paymentId: orders.paybridgePaymentId })
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(r?.paymentId).toBeTruthy();
    return { order, paymentId: r!.paymentId! };
  };

  /** The body PayBridge sends for a payment's final status. */
  const eventFor = (
    paymentId: string,
    status: PayBridgeStatus,
    changes: Record<string, unknown> = {},
  ) => {
    const payment = paybridge.payment(paymentId)!;
    return JSON.stringify({
      id: `evt_${paymentId}`,
      type: `payment.${status.toLowerCase()}`,
      created_at: new Date().toISOString(),
      data: {
        ...payment,
        status,
        completed_at: new Date().toISOString(),
        ...changes,
      },
    });
  };

  const deliver = (
    body: string,
    // null sends no header (undefined would take the default).
    signature: string | null = signWebhook(SECRET, body),
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/webhooks/paybridge",
      headers: {
        "content-type": "application/json",
        ...(signature !== null && { "x-paybridge-signature": signature }),
      },
      payload: body,
    });

  const orderRow = async (id: string) => {
    const [r] = await app.db.select().from(orders).where(eq(orders.id, id));
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

  const outboxFor = async (orderId: string) =>
    (await app.db.select().from(outbox)).filter(
      (r) => (r.payload as { order_id: string }).order_id === orderId,
    );

  const processed = async (eventId: string) =>
    app.db
      .select()
      .from(processedWebhooks)
      .where(eq(processedWebhooks.eventId, eventId));

  describe("a verified payment.succeeded", () => {
    it("marks the order paid, consumes the stock and queues the confirmations", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);

      const res = await deliver(eventFor(paymentId, "SUCCEEDED"));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect((await orderRow(order.id)).status).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 8, reserved: 0 });
      expect(await holds(order.id)).toEqual(["CONSUMED"]);

      const queued = await outboxFor(order.id);
      expect(queued.map((r) => r.type).sort()).toEqual([
        "order_confirmation.email",
        "order_confirmation.sms",
      ]);
      expect(queued.find((r) => r.type.endsWith("email"))!.payload).toEqual({
        order_id: order.id,
        to: "wanjiru@example.co.ke",
        total: 3000,
        items: [{ title: "Kiondo bag", quantity: 2, line_total: 3000 }],
      });
      expect(queued.find((r) => r.type.endsWith("sms"))!.payload).toMatchObject(
        { to: "254712345678" },
      );
      expect(queued.every((r) => r.processedAt === null)).toBe(true);
    });

    it("changes the order once when the same event arrives 5 times", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 3);
      const body = eventFor(paymentId, "SUCCEEDED");

      const responses = [];
      for (let i = 0; i < 5; i++) responses.push(await deliver(body));

      expect(responses.map((r) => r.statusCode)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(responses.filter((r) => r.json().duplicate)).toHaveLength(4);
      expect(await stock(product)).toEqual({ onHand: 7, reserved: 0 });
      expect(await outboxFor(order.id)).toHaveLength(2);
      expect(await processed(`evt_${paymentId}`)).toHaveLength(1);
    });

    it("changes the order once when 5 copies arrive at the same time", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 3);
      const body = eventFor(paymentId, "SUCCEEDED");

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => deliver(body)),
      );

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(responses.filter((r) => r.json().duplicate)).toHaveLength(4);
      expect((await orderRow(order.id)).status).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 7, reserved: 0 });
      expect(await outboxFor(order.id)).toHaveLength(2);
    });

    it("flags the order instead of paying it when the amount doesn't match", async () => {
      const product = await createProduct(10, 1500);
      const { order, paymentId } = await placeOrder(product, 1);

      const res = await deliver(
        eventFor(paymentId, "SUCCEEDED", { amount: 15 }),
      );

      expect(res.statusCode).toBe(200);
      const row = await orderRow(order.id);
      expect(row.status).toBe("PENDING_PAYMENT");
      expect(row.flaggedReason).toBe(
        `PayBridge payment ${paymentId} succeeded for KES 15, but the order total is KES 1500`,
      );
      expect(row.flaggedAt).toBeInstanceOf(Date);
      expect(await stock(product)).toEqual({ onHand: 10, reserved: 1 });
      expect(await outboxFor(order.id)).toHaveLength(0);
    });

    it("doesn't pay an order twice when a status poll already did", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);
      paybridge.settle(paymentId, "SUCCEEDED");
      await app.redis.del(`paybridge:sync:${order.id}`);
      await app.inject({ method: "GET", url: `/v1/orders/${order.id}/status` });
      expect((await orderRow(order.id)).status).toBe("PAID");

      const res = await deliver(eventFor(paymentId, "SUCCEEDED"));

      expect(res.statusCode).toBe(200);
      expect(await stock(product)).toEqual({ onHand: 8, reserved: 0 });
      expect(await outboxFor(order.id)).toHaveLength(2);
    });
  });

  it.each(["FAILED", "CANCELLED", "TIMED_OUT"] as const)(
    "releases the stock for payment.%s",
    async (status) => {
      const product = await createProduct(4);
      const { order, paymentId } = await placeOrder(product, 3);

      const res = await deliver(
        eventFor(paymentId, status, {
          result_desc: "Request cancelled by user",
        }),
      );

      expect(res.statusCode).toBe(200);
      expect((await orderRow(order.id)).status).toBe("PAYMENT_FAILED");
      expect(await stock(product)).toEqual({ onHand: 4, reserved: 0 });
      expect(await holds(order.id)).toEqual(["RELEASED"]);
      expect(await outboxFor(order.id)).toHaveLength(0);
    },
  );

  describe("rejects with 401, changing nothing", () => {
    const expectRejected = async (
      res: Awaited<ReturnType<typeof deliver>>,
      orderId: string,
      productId: string,
    ) => {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_SIGNATURE");
      expect((await orderRow(orderId)).status).toBe("PENDING_PAYMENT");
      expect(await stock(productId)).toEqual({ onHand: 10, reserved: 2 });
    };

    it("a tampered body", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);
      const signed = eventFor(paymentId, "FAILED");
      const tampered = signed.replace(
        '"status":"FAILED"',
        '"status":"SUCCEEDED"',
      );
      expect(tampered).not.toBe(signed);

      await expectRejected(
        await deliver(tampered, signWebhook(SECRET, signed)),
        order.id,
        product,
      );
    });

    it("a signature made with the wrong secret", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);
      const body = eventFor(paymentId, "SUCCEEDED");

      await expectRejected(
        await deliver(body, signWebhook("whsec_attacker", body)),
        order.id,
        product,
      );
    });

    it("a stale timestamp", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);
      const body = eventFor(paymentId, "SUCCEEDED");
      const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;

      await expectRejected(
        await deliver(body, signWebhook(SECRET, body, sixMinutesAgo)),
        order.id,
        product,
      );
      // Nothing was recorded, so the real, fresh delivery still applies.
      expect(await processed(`evt_${paymentId}`)).toHaveLength(0);
    });

    it("a missing signature", async () => {
      const product = await createProduct(10);
      const { order, paymentId } = await placeOrder(product, 2);

      await expectRejected(
        await deliver(eventFor(paymentId, "SUCCEEDED"), null),
        order.id,
        product,
      );
    });
  });

  it("answers 404 for a payment it doesn't know, so PayBridge retries", async () => {
    const body = JSON.stringify({
      id: "evt_unknown",
      type: "payment.succeeded",
      data: { id: "unknown", status: "SUCCEEDED", amount: 100 },
    });

    const res = await deliver(body);

    expect(res.statusCode).toBe(404);
    expect(await processed("evt_unknown")).toHaveLength(0);
  });

  it("answers 400 for a signed body it can't read", async () => {
    const res = await deliver('{"id":"evt_x","data":{"status":"PAID"}}');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_EVENT");
  });

  it("acknowledges a non-final status without recording it", async () => {
    const product = await createProduct(10);
    const { order, paymentId } = await placeOrder(product, 1);

    const res = await deliver(eventFor(paymentId, "PENDING"));

    expect(res.statusCode).toBe(200);
    expect(await processed(`evt_${paymentId}`)).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe("PENDING_PAYMENT");
  });
});
