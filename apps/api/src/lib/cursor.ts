import { z } from "zod";

/**
 * Keyset pagination cursor: the (created_at, id) of the last row on a page.
 *
 * created_at is kept as Postgres' own text rendering rather than a JS Date,
 * because Date truncates Postgres' microseconds to milliseconds and would make
 * rows that share a millisecond skip or repeat across pages.
 */
const cursorSchema = z.object({ createdAt: z.string().min(1), id: z.uuid() });
export type Cursor = z.infer<typeof cursorSchema>;

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

/** Returns null for anything that isn't a cursor this API issued. */
export const decodeCursor = (raw: string): Cursor | null => {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
