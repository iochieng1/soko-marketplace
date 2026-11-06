import { describe, expect, it } from "vitest";

import {
  formatKes,
  healthResponseSchema,
  listProductsQuerySchema,
  productListResponseSchema,
  productSchema,
} from "../src/index.js";

const product = {
  id: "0b7c6f0e-6a43-4f3a-9d6c-2f1f3c1f2a10",
  seller_id: "5a1d0f8e-1c2b-4d3e-8f9a-0b1c2d3e4f50",
  title: "Kikoy beach wrap",
  slug: "kikoy-beach-wrap",
  description: "Hand-woven cotton kikoy from Mombasa.",
  price: 1500,
  currency: "KES",
  status: "ACTIVE",
  created_at: "2026-11-06T09:00:00.000Z",
};

describe("productSchema", () => {
  it("accepts a valid product", () => {
    expect(productSchema.parse(product)).toEqual(product);
  });

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["fractional", 99.5],
  ])("rejects a %s price", (_label, price) => {
    expect(productSchema.safeParse({ ...product, price }).success).toBe(false);
  });

  it("rejects unknown statuses and non-KES currencies", () => {
    expect(
      productSchema.safeParse({ ...product, status: "SOLD" }).success,
    ).toBe(false);
    expect(
      productSchema.safeParse({ ...product, currency: "USD" }).success,
    ).toBe(false);
  });
});

describe("productListResponseSchema", () => {
  it("accepts an empty page", () => {
    expect(
      productListResponseSchema.parse({ data: [], next_cursor: null }),
    ).toEqual({ data: [], next_cursor: null });
  });

  it("requires next_cursor to be present", () => {
    expect(productListResponseSchema.safeParse({ data: [] }).success).toBe(
      false,
    );
  });
});

describe("listProductsQuerySchema", () => {
  it("defaults limit to 20 and coerces query-string numbers", () => {
    expect(listProductsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listProductsQuerySchema.parse({ limit: "5" })).toEqual({ limit: 5 });
  });

  it.each(["0", "101", "abc"])("rejects limit=%s", (limit) => {
    expect(listProductsQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe("healthResponseSchema", () => {
  it("accepts a degraded response", () => {
    const body = { status: "degraded", checks: { db: "ok", redis: "error" } };
    expect(healthResponseSchema.parse(body)).toEqual(body);
  });
});

describe("formatKes", () => {
  it("formats whole shillings without decimals", () => {
    expect(formatKes(1500)).toMatch(/^Ksh\s?1,500$/);
  });
});
