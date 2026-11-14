import { describe, expect, it } from "vitest";

import { slugify, withSuffix } from "../src/lib/slug.js";

describe("slugify", () => {
  it.each([
    ["Kikoy Beach Wrap (Blue)", "kikoy-beach-wrap-blue"],
    ["  Kenya AA coffee, 500 g  ", "kenya-aa-coffee-500-g"],
    ["Café crème brûlée", "cafe-creme-brulee"],
    ["---", "product"],
    ["🔥🔥", "product"],
  ])("%j -> %j", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("caps length without leaving a trailing dash", () => {
    const slug = slugify(`${"a".repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("withSuffix", () => {
  it("appends a 6-character random suffix", () => {
    expect(withSuffix("kikoy")).toMatch(/^kikoy-[0-9a-z]{6}$/);
    expect(withSuffix("kikoy")).not.toBe(withSuffix("kikoy"));
  });
});
