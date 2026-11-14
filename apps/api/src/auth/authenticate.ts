import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { sendError } from "../lib/errors.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** The logged-in seller's id. Only set behind `requireSeller`. */
    sellerId: string;
  }
}

/** Registers access-token signing/verification on the root instance. */
export const jwtPlugin = fp(async (app: FastifyInstance) => {
  await app.register(jwt, {
    secret: app.config.JWT_SECRET,
    sign: {
      algorithm: "HS256",
      expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS,
    },
    // Pin the algorithm so a token can't pick a weaker one (or "none").
    verify: { algorithms: ["HS256"] },
  });
  app.decorateRequest("sellerId", "");
});

/**
 * onRequest hook for seller-only routes. Any missing, malformed, expired or
 * forged token gets the same 401, so the response says nothing about why.
 */
export const requireSeller = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const { sub } = await request.jwtVerify<{ sub: string }>();
    request.sellerId = sub;
  } catch {
    return sendError(
      reply,
      401,
      "UNAUTHORIZED",
      "A valid access token is required",
    );
  }
};
