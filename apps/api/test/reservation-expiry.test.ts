import { orderSchema, sellerProductSchema } from "@soko/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { inventory, orders, stockReservations } from "../src/db/schema.js";
import { startReservationSweeper } from "../src/jobs/reservation-sweeper.js";
import { confirmPayment } from "../src/lib/payments.js";
import { sweepExpiredReservations } from "../src/lib/reservations.js";
import {
  buildTestApp,
  createIsolatedDatabase,
  registerSeller,
  testConfig,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

// The sweeper acts on every expired reservation in the database, so this file
// gets its own: other test files' orders can't change what it counts.
describe("reservation expiry", () => {
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp({ DATABASE_URL: await createIsolatedDatabase() });
    ({ auth } = await registerSeller(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const createProduct = async (onHand: number) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seller/products",
      headers: auth,
      payload: {
        title: "Expiry product",
        status: "ACTIVE",
        price: 100,
        on_hand: onHand,
      },
    });
    expect(res.statusCode).toBe(201);
    return sellerProductSchema.parse(res.json()).id;
  };

  const placeOrder = async (lines: [productId: string, quantity: number][]) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        customer_email: "otieno@example.co.ke",
        customer_phone: "0712345678",
        items: lines.map(([product_id, quantity]) => ({
          product_id,
          quantity,
        })),
      },
    });
    expect(res.statusCode).toBe(201);
    return orderSchema.parse(res.json()).id;
  };

  /** Moves an order's reservations into the past, as if the TTL ran out. */
  const backdate = (...orderIds: string[]) =>
    app.db
      .update(stockReservations)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(inArray(stockReservations.orderId, orderIds));

  const stock = async (productId: string) => {
    const [row] = await app.db
      .select({ onHand: inventory.onHand, reserved: inventory.reserved })
      .from(inventory)
      .where(eq(inventory.productId, productId));
    return row!;
  };

  const statusOf = async (orderId: string) => {
    const [row] = await app.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));
    return row!.status;
  };

  const holds = (orderId: string) =>
    app.db
      .select({
        status: stockReservations.status,
        quantity: stockReservations.quantity,
      })
      .from(stockReservations)
      .where(eq(stockReservations.orderId, orderId));

  describe("sweeper", () => {
    it("returns expired stock to the pool and expires the order", async () => {
      const a = await createProduct(10);
      const b = await createProduct(5);
      const expired = await placeOrder([
        [a, 3],
        [b, 2],
      ]);
      const live = await placeOrder([[a, 1]]);
      await backdate(expired);

      expect(await sweepExpiredReservations(app.db)).toEqual({
        expiredOrders: 1,
        releasedReservations: 2,
      });

      expect(await stock(a)).toEqual({ onHand: 10, reserved: 1 });
      expect(await stock(b)).toEqual({ onHand: 5, reserved: 0 });
      expect(await statusOf(expired)).toBe("EXPIRED");
      expect((await holds(expired)).map((h) => h.status)).toEqual([
        "RELEASED",
        "RELEASED",
      ]);
      // A hold that hasn't run out is left alone.
      expect(await statusOf(live)).toBe("PENDING_PAYMENT");
      expect(await holds(live)).toEqual([{ status: "ACTIVE", quantity: 1 }]);

      // The released stock can be bought again.
      await placeOrder([[b, 5]]);
      expect(await stock(b)).toEqual({ onHand: 5, reserved: 5 });
    });

    it("releases nothing the second time it runs", async () => {
      const product = await createProduct(4);
      const order = await placeOrder([[product, 3]]);
      await placeOrder([[product, 1]]);
      await backdate(order);

      await sweepExpiredReservations(app.db);
      expect(await sweepExpiredReservations(app.db)).toEqual({
        expiredOrders: 0,
        releasedReservations: 0,
      });
      expect(await stock(product)).toEqual({ onHand: 4, reserved: 1 });
    });

    it("releases each reservation exactly once when sweepers race", async () => {
      const product = await createProduct(100);
      const ids = await Promise.all(
        Array.from({ length: 30 }, () => placeOrder([[product, 2]])),
      );
      const keep = await placeOrder([[product, 7]]);
      await backdate(...ids);

      // Small batches so the racing sweepers loop and overlap repeatedly.
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          sweepExpiredReservations(app.db, { batchSize: 4 }),
        ),
      );
      // A sweeper that found every order locked by another may stop early;
      // one more pass picks up anything left.
      results.push(await sweepExpiredReservations(app.db));

      const sum = (k: "expiredOrders" | "releasedReservations") =>
        results.reduce((s, r) => s + r[k], 0);
      expect(sum("expiredOrders")).toBe(30);
      expect(sum("releasedReservations")).toBe(30);
      // Released twice would have pushed reserved below 7 (or tripped the
      // reserved >= 0 CHECK). Exactly the live order's hold is left.
      expect(await stock(product)).toEqual({ onHand: 100, reserved: 7 });
      expect(await statusOf(keep)).toBe("PENDING_PAYMENT");
    });

    it("runs on its BullMQ schedule", async () => {
      const product = await createProduct(3);
      const order = await placeOrder([[product, 3]]);
      await backdate(order);

      const sweeper = await startReservationSweeper({
        db: app.db,
        redisUrl: testConfig().REDIS_URL,
        log: app.log,
        everyMs: 200,
        prefix: `test-${crypto.randomUUID()}`,
      });
      try {
        await expect
          .poll(() => statusOf(order), { timeout: 10_000, interval: 100 })
          .toBe("EXPIRED");
      } finally {
        await sweeper.close();
      }
      expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
    });
  });

  describe("payment", () => {
    it("consumes the held stock for an order paid in time", async () => {
      const product = await createProduct(5);
      const order = await placeOrder([[product, 2]]);

      expect(await confirmPayment(app.db, order)).toBe("PAID");
      expect(await statusOf(order)).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
      expect(await holds(order)).toEqual([{ status: "CONSUMED", quantity: 2 }]);

      // The sweeper never touches a paid order, even after its TTL.
      await backdate(order);
      await sweepExpiredReservations(app.db);
      expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
    });

    it("is a no-op when the same payment is applied twice", async () => {
      const product = await createProduct(5);
      const order = await placeOrder([[product, 2]]);

      await confirmPayment(app.db, order);
      expect(await confirmPayment(app.db, order)).toBe("ALREADY_SETTLED");
      expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
    });

    it("still counts a payment that beats the sweeper past the TTL", async () => {
      const product = await createProduct(5);
      const order = await placeOrder([[product, 2]]);
      await backdate(order);

      expect(await confirmPayment(app.db, order)).toBe("PAID");
      expect(await sweepExpiredReservations(app.db)).toEqual({
        expiredOrders: 0,
        releasedReservations: 0,
      });
      expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
    });

    it("returns undefined for an unknown order", async () => {
      expect(await confirmPayment(app.db, crypto.randomUUID())).toBe(undefined);
    });

    describe("arriving after the order expired", () => {
      it("re-reserves the stock when it's still available", async () => {
        const product = await createProduct(5);
        const order = await placeOrder([[product, 2]]);
        await backdate(order);
        await sweepExpiredReservations(app.db);
        expect(await stock(product)).toEqual({ onHand: 5, reserved: 0 });

        expect(await confirmPayment(app.db, order)).toBe("PAID_LATE");
        expect(await statusOf(order)).toBe("PAID");
        expect(await stock(product)).toEqual({ onHand: 3, reserved: 0 });
        expect(await holds(order)).toEqual(
          expect.arrayContaining([
            { status: "RELEASED", quantity: 2 },
            { status: "CONSUMED", quantity: 2 },
          ]),
        );
      });

      it("flags the order for a refund when the stock was sold on", async () => {
        const product = await createProduct(2);
        const order = await placeOrder([[product, 2]]);
        await backdate(order);
        await sweepExpiredReservations(app.db);
        // Someone else buys the released stock.
        const other = await placeOrder([[product, 2]]);

        expect(await confirmPayment(app.db, order)).toBe("REFUND_PENDING");
        expect(await statusOf(order)).toBe("REFUND_PENDING");
        // The other customer's hold is untouched.
        expect(await stock(product)).toEqual({ onHand: 2, reserved: 2 });
        expect(await holds(other)).toEqual([{ status: "ACTIVE", quantity: 2 }]);
        // A retried webhook doesn't change its mind.
        expect(await confirmPayment(app.db, order)).toBe("ALREADY_SETTLED");
      });

      it("takes all lines or none", async () => {
        const plenty = await createProduct(10);
        const scarce = await createProduct(1);
        const order = await placeOrder([
          [plenty, 3],
          [scarce, 1],
        ]);
        await backdate(order);
        await sweepExpiredReservations(app.db);
        await placeOrder([[scarce, 1]]);

        expect(await confirmPayment(app.db, order)).toBe("REFUND_PENDING");
        // The line that was available wasn't taken.
        expect(await stock(plenty)).toEqual({ onHand: 10, reserved: 0 });
        expect(await stock(scarce)).toEqual({ onHand: 1, reserved: 1 });
      });
    });

    it("never double-counts when payment and sweeper race", async () => {
      const product = await createProduct(50);
      const ids = await Promise.all(
        Array.from({ length: 20 }, () => placeOrder([[product, 1]])),
      );
      await backdate(...ids);

      const outcomes = await Promise.all([
        ...ids.map((id) => confirmPayment(app.db, id)),
        sweepExpiredReservations(app.db, { batchSize: 3 }),
        sweepExpiredReservations(app.db, { batchSize: 3 }),
      ]);

      // Whoever won, every order ends up paid (stock was plentiful), the
      // stock left on_hand exactly once, and nothing is still held.
      for (const outcome of outcomes.slice(0, ids.length)) {
        expect(["PAID", "PAID_LATE"]).toContain(outcome);
      }
      for (const id of ids) expect(await statusOf(id)).toBe("PAID");
      expect(await stock(product)).toEqual({ onHand: 30, reserved: 0 });
    });
  });
});
