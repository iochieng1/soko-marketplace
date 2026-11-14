import { describe, expect, it } from "vitest";

import {
  createProductRequestSchema,
  updateProductRequestSchema,
} from "../src/index.js";

describe("product request schemas", () => {
  it("defaults new products to an empty DRAFT with no stock", () => {
    expect(
      createProductRequestSchema.parse({ title: "Kikoy", price: "1500" }),
    ).toEqual({
      title: "Kikoy",
      description: "",
      price: 1500,
      status: "DRAFT",
      on_hand: 0,
    });
  });

  it("won't create a product straight into ARCHIVED", () => {
    expect(
      createProductRequestSchema.safeParse({
        title: "Kikoy",
        price: 1500,
        status: "ARCHIVED",
      }).success,
    ).toBe(false);
  });

  it("rejects prices M-Pesa can't collect", () => {
    expect(
      createProductRequestSchema.safeParse({ title: "Car", price: 250_001 })
        .success,
    ).toBe(false);
  });

  it("requires at least one field on update", () => {
    expect(updateProductRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProductRequestSchema.parse({ on_hand: 3 })).toEqual({
      on_hand: 3,
    });
  });

  it("rejects negative stock", () => {
    expect(updateProductRequestSchema.safeParse({ on_hand: -1 }).success).toBe(
      false,
    );
  });
});
