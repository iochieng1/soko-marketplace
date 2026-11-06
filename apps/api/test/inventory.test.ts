import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createDb } from "../src/db/client.js";
import { inventory, products, sellers } from "../src/db/schema.js";

/** Walks the error cause chain (Drizzle wraps the postgres.js error). */
const pgError = (err: unknown): { code?: string; constraint_name?: string } => {
  let current: unknown = err;
  while (current instanceof Error) {
    if ("code" in current && "constraint_name" in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = current.cause;
  }
  return {};
};

const expectViolation = async (write: Promise<unknown>, constraint: string) => {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the write to be rejected").toBeDefined();
  // 23514 = check_violation
  expect(pgError(err)).toMatchObject({
    code: "23514",
    constraint_name: constraint,
  });
};

// These tests talk to Postgres directly, bypassing all application code: the
// point is that the database itself refuses to store an oversold state.
describe("inventory CHECK constraints (last line of defence against oversell)", () => {
  const { db, sql: client } = createDb(inject("databaseUrl"));
  let productId: string;

  beforeAll(async () => {
    const [seller] = await db
      .insert(sellers)
      .values({
        name: "Constraint Test Seller",
        email: `inventory-${randomUUID()}@example.co.ke`,
        phone: "254700000000",
      })
      .returning();
    // DRAFT so it never shows up in the public catalogue tests.
    const [product] = await db
      .insert(products)
      .values({
        sellerId: seller!.id,
        title: "Constraint test product",
        slug: `constraint-test-${randomUUID()}`,
        price: 100,
        status: "DRAFT",
      })
      .returning();
    productId = product!.id;
    await db.insert(inventory).values({ productId, onHand: 5, reserved: 0 });
  });

  afterAll(async () => {
    await client.end();
  });

  const stock = async () => {
    const [row] = await db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    return row!;
  };

  it("allows reserving exactly what is on hand", async () => {
    await db
      .update(inventory)
      .set({ reserved: 5 })
      .where(eq(inventory.productId, productId));

    expect(await stock()).toMatchObject({ onHand: 5, reserved: 5 });

    await db
      .update(inventory)
      .set({ reserved: 0 })
      .where(eq(inventory.productId, productId));
  });

  it("rejects an UPDATE that would reserve more than is on hand", async () => {
    await expectViolation(
      db
        .update(inventory)
        .set({ reserved: sql`${inventory.reserved} + 6` })
        .where(eq(inventory.productId, productId)),
      "inventory_reserved_within_on_hand",
    );

    // The failed write left no trace.
    expect(await stock()).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it("rejects reducing on_hand below what is already reserved", async () => {
    await db
      .update(inventory)
      .set({ reserved: 3 })
      .where(eq(inventory.productId, productId));

    await expectViolation(
      db
        .update(inventory)
        .set({ onHand: 2 })
        .where(eq(inventory.productId, productId)),
      "inventory_reserved_within_on_hand",
    );

    await db
      .update(inventory)
      .set({ reserved: 0 })
      .where(eq(inventory.productId, productId));
  });

  it("rejects releasing more than was reserved (reserved < 0)", async () => {
    await expectViolation(
      db
        .update(inventory)
        .set({ reserved: sql`${inventory.reserved} - 1` })
        .where(eq(inventory.productId, productId)),
      "inventory_reserved_non_negative",
    );
  });

  it("rolls back the whole transaction when a reservation oversells", async () => {
    await expectViolation(
      db.transaction(async (tx) => {
        await tx
          .update(inventory)
          .set({ reserved: 4 })
          .where(eq(inventory.productId, productId));
        await tx
          .update(inventory)
          .set({ reserved: sql`${inventory.reserved} + 2` })
          .where(eq(inventory.productId, productId));
      }),
      "inventory_reserved_within_on_hand",
    );

    expect(await stock()).toMatchObject({ onHand: 5, reserved: 0 });
  });
});
