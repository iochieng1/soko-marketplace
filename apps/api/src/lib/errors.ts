import type { ErrorResponse } from "@soko/shared";
import type { FastifyReply } from "fastify";

/** Sends the API's standard error envelope: { error: { code, message } }. */
export const sendError = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => {
  const body: ErrorResponse = { error: { code, message, details } };
  return reply.code(status).send(body);
};

/** Walks the cause chain to the postgres.js error (Drizzle wraps it). */
export const pgError = (
  err: unknown,
): { code?: string; constraint_name?: string } => {
  let current: unknown = err;
  while (current instanceof Error) {
    if ("code" in current && "constraint_name" in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = current.cause;
  }
  return {};
};

export const isUniqueViolation = (err: unknown, constraint: string) => {
  const pg = pgError(err);
  return pg.code === "23505" && pg.constraint_name === constraint;
};

export const isCheckViolation = (err: unknown, constraint: string) => {
  const pg = pgError(err);
  return pg.code === "23514" && pg.constraint_name === constraint;
};

/** Postgres rejects a malformed uuid with 22P02 before running the query. */
export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
