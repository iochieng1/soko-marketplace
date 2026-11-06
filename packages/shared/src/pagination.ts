import { z } from "zod";

/**
 * Cursor-paginated list envelope. `next_cursor` is opaque to clients: pass it
 * back as `?cursor=` to fetch the next page; `null` means there are no more.
 */
export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });

export type Paginated<T> = { data: T[]; next_cursor: string | null };
