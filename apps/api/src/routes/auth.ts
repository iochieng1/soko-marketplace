import {
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  type AuthResponse,
  type Seller,
  type TokenPair,
} from "@soko/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import { requireSeller } from "../auth/authenticate.js";
import {
  burnPasswordCheck,
  hashPassword,
  verifyPassword,
} from "../auth/password.js";
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../auth/refresh-tokens.js";
import { sellers } from "../db/schema.js";
import { isUniqueViolation, sendError } from "../lib/errors.js";

type SellerRow = typeof sellers.$inferSelect;

const toSeller = (row: SellerRow): Seller => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  created_at: row.createdAt.toISOString(),
});

const authRoutes: FastifyPluginAsync = async (app) => {
  const { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS } = app.config;

  const tokensFor = async (
    sellerId: string,
    refreshToken?: string,
  ): Promise<TokenPair> => ({
    token_type: "Bearer",
    access_token: await app.jwt.sign({ sub: sellerId }),
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token:
      refreshToken ??
      (await issueRefreshToken(app.db, sellerId, REFRESH_TOKEN_TTL_DAYS)),
  });

  app.post("/auth/register", async (request, reply) => {
    const body = registerRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    const { name, email, phone, password } = body.data;

    let row: SellerRow | undefined;
    try {
      [row] = await app.db
        .insert(sellers)
        .values({
          name,
          email,
          phone,
          passwordHash: await hashPassword(password),
        })
        .returning();
    } catch (err) {
      // The unique index is on lower(email), so Jane@x.com and jane@x.com
      // collide here, in the database, with no check-then-insert race.
      if (isUniqueViolation(err, "sellers_email_lower_idx")) {
        return sendError(
          reply,
          409,
          "EMAIL_TAKEN",
          "An account with this email already exists",
        );
      }
      throw err;
    }
    if (!row) throw new Error("Seller insert returned no row");

    const response: AuthResponse = {
      seller: toSeller(row),
      ...(await tokensFor(row.id)),
    };
    return reply.code(201).send(response);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    const { email, password } = body.data;

    const [row] = await app.db
      .select()
      .from(sellers)
      .where(sql`lower(${sellers.email}) = lower(${email})`);

    const valid = row
      ? await verifyPassword(row.passwordHash, password)
      : await burnPasswordCheck(password).then(() => false);

    // Same response for "no such email" and "wrong password".
    if (!row || !valid) {
      return sendError(
        reply,
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect",
      );
    }

    const response: AuthResponse = {
      seller: toSeller(row),
      ...(await tokensFor(row.id)),
    };
    return response;
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = refreshRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }

    const result = await rotateRefreshToken(
      app.db,
      body.data.refresh_token,
      REFRESH_TOKEN_TTL_DAYS,
    );
    if (!result.ok) {
      if (result.reason === "reused") {
        request.log.warn("Refresh token reuse detected; session revoked");
      }
      return sendError(
        reply,
        401,
        "INVALID_REFRESH_TOKEN",
        "Refresh token is invalid or expired",
      );
    }

    return tokensFor(result.sellerId, result.refreshToken);
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = refreshRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid request body",
        body.error.issues,
      );
    }
    await revokeRefreshToken(app.db, body.data.refresh_token);
    return reply.code(204).send();
  });

  app.get("/auth/me", { onRequest: requireSeller }, async (request, reply) => {
    const [row] = await app.db
      .select()
      .from(sellers)
      .where(eq(sellers.id, request.sellerId));
    // A valid token for a seller who no longer exists.
    if (!row) {
      return sendError(
        reply,
        401,
        "UNAUTHORIZED",
        "A valid access token is required",
      );
    }
    return toSeller(row);
  });
};

export default authRoutes;
