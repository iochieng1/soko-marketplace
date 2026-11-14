import { randomBytes } from "node:crypto";

/**
 * URL slug from a product title: "Kikoy Beach Wrap (Blue)" -> "kikoy-beach-wrap-blue".
 * Accents are folded to ASCII; anything left that isn't a-z/0-9 becomes a dash.
 */
export const slugify = (title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return slug || "product";
};

/** Suffix for a slug that's already taken: "kikoy-beach-wrap-7k2m9q". */
export const withSuffix = (slug: string): string =>
  `${slug}-${randomBytes(4).readUInt32BE().toString(36).padStart(6, "0").slice(0, 6)}`;
