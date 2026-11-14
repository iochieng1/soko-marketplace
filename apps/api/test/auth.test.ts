import { createHmac } from "node:crypto";

import { authResponseSchema, tokenPairSchema } from "@soko/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { refreshTokens, sellers } from "../src/db/schema.js";
import { buildTestApp, registerSeller } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

/** Builds an HS256 JWT by hand, e.g. signed with the wrong secret. */
const signJwt = (
  payload: object,
  secret: string,
  header: object = { alg: "HS256", typ: "JWT" },
) => {
  const b64 = (v: object) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
};

describe("seller auth", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, payload: payload as object });

  const me = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: authorization ? { authorization } : {},
    });

  describe("POST /v1/auth/register", () => {
    it("creates a seller, normalises the phone and returns tokens", async () => {
      const email = `New-${crypto.randomUUID()}@Example.co.ke`;
      const res = await post("/v1/auth/register", {
        name: "Mama Mboga",
        email,
        phone: "+254 712 345 678",
        password: "sukuma wiki 2026",
      });

      expect(res.statusCode).toBe(201);
      const body = authResponseSchema.parse(res.json());
      expect(body.seller).toMatchObject({
        name: "Mama Mboga",
        email,
        phone: "254712345678",
      });
      expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
      expect(JSON.stringify(body)).not.toContain("password");

      // Stored as argon2id, never as plaintext.
      const [row] = await app.db
        .select({ passwordHash: sellers.passwordHash })
        .from(sellers)
        .where(eq(sellers.id, body.seller.id));
      expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(row?.passwordHash).not.toContain("sukuma");
    });

    it("rejects a duplicate email in any letter case with 409", async () => {
      const email = `dupe-${crypto.randomUUID()}@example.co.ke`;
      await registerSeller(app, { email });

      for (const variant of [email, email.toUpperCase(), ` ${email} `]) {
        const res = await post("/v1/auth/register", {
          name: "Copycat",
          email: variant,
          phone: "0712345678",
          password: "another password",
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: { code: "EMAIL_TAKEN" } });
      }
    });

    it.each([
      ["a short password", { password: "short" }],
      ["a bad email", { email: "nope" }],
      ["a non-Kenyan phone", { phone: "+1 415 555 0100" }],
      ["a missing name", { name: undefined }],
    ])("rejects %s with 400", async (_label, override) => {
      const res = await post("/v1/auth/register", {
        name: "Seller",
        email: `bad-${crypto.randomUUID()}@example.co.ke`,
        phone: "0712345678",
        password: "long enough password",
        ...override,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    });
  });

  describe("POST /v1/auth/login", () => {
    it("logs in with the right password, whatever the email's case", async () => {
      const { seller } = await registerSeller(app, {
        password: "open sesame 123",
      });

      const res = await post("/v1/auth/login", {
        email: seller.email.toUpperCase(),
        password: "open sesame 123",
      });

      expect(res.statusCode).toBe(200);
      const body = authResponseSchema.parse(res.json());
      expect(body.seller.id).toBe(seller.id);
      expect((await me(`Bearer ${body.access_token}`)).statusCode).toBe(200);
    });

    it("gives a wrong password and an unknown email the same 401", async () => {
      const { seller } = await registerSeller(app);

      const wrongPassword = await post("/v1/auth/login", {
        email: seller.email,
        password: "not the password",
      });
      const unknownEmail = await post("/v1/auth/login", {
        email: `ghost-${crypto.randomUUID()}@example.co.ke`,
        password: "not the password",
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownEmail.json());
    });

    it("can't log in as a seller whose password was never set", async () => {
      // The 0001 migration backfills pre-auth sellers with "!".
      const { seller } = await registerSeller(app);
      await app.db
        .update(sellers)
        .set({ passwordHash: "!" })
        .where(eq(sellers.id, seller.id));

      const res = await post("/v1/auth/login", {
        email: seller.email,
        password: "!",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("access tokens", () => {
    it("GET /v1/auth/me returns the seller for a valid token", async () => {
      const { seller, auth } = await registerSeller(app);

      const res = await me(auth.authorization);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(seller);
    });

    it("issues access tokens for the seller that expire in 15 minutes", async () => {
      const { seller, access_token } = await registerSeller(app);
      const payload = JSON.parse(
        Buffer.from(access_token.split(".")[1]!, "base64url").toString(),
      ) as { sub: string; iat: number; exp: number };

      expect(payload.sub).toBe(seller.id);
      // @fastify/jwt reads a numeric expiresIn as seconds.
      expect(payload.exp - payload.iat).toBe(900);
    });

    it.each([
      ["no token", undefined],
      ["a malformed token", "Bearer not.a.jwt"],
      ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ])("rejects %s with 401", async (_label, authorization) => {
      const res = await me(authorization);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("rejects a token signed with another secret", async () => {
      const { seller } = await registerSeller(app);
      const forged = signJwt(
        { sub: seller.id, exp: Math.floor(Date.now() / 1000) + 600 },
        "attacker-secret-attacker-secret-attacker",
      );
      expect((await me(`Bearer ${forged}`)).statusCode).toBe(401);
    });

    it('rejects an unsigned alg "none" token', async () => {
      const { seller } = await registerSeller(app);
      const b64 = (v: object) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: seller.id })}.`;
      expect((await me(`Bearer ${none}`)).statusCode).toBe(401);
    });

    it("rejects an expired token", async () => {
      const { seller } = await registerSeller(app);
      const expired = signJwt(
        { sub: seller.id, exp: Math.floor(Date.now() / 1000) - 60 },
        app.config.JWT_SECRET,
      );
      expect((await me(`Bearer ${expired}`)).statusCode).toBe(401);
    });
  });

  describe("refresh token rotation", () => {
    const refresh = (refresh_token: string) =>
      post("/v1/auth/refresh", { refresh_token });

    it("swaps a refresh token for a new pair", async () => {
      const { refresh_token } = await registerSeller(app);

      const res = await refresh(refresh_token);

      expect(res.statusCode).toBe(200);
      const pair = tokenPairSchema.parse(res.json());
      expect(pair.refresh_token).not.toBe(refresh_token);
      expect((await me(`Bearer ${pair.access_token}`)).statusCode).toBe(200);
    });

    it("stores only a hash of the refresh token", async () => {
      const { refresh_token, seller } = await registerSeller(app);
      const rows = await app.db
        .select({ tokenHash: refreshTokens.tokenHash })
        .from(refreshTokens)
        .where(eq(refreshTokens.sellerId, seller.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.tokenHash).not.toBe(refresh_token);
    });

    it("revokes the whole session when a used token is replayed", async () => {
      const { refresh_token: first } = await registerSeller(app);
      const second = tokenPairSchema.parse((await refresh(first)).json());

      // Someone replays the first token (it was stolen, or the client is buggy).
      const replay = await refresh(first);
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({
        error: { code: "INVALID_REFRESH_TOKEN" },
      });

      // The legitimate-looking successor is now dead too.
      expect((await refresh(second.refresh_token)).statusCode).toBe(401);
    });

    it("lets exactly one of two concurrent refreshes win", async () => {
      const { refresh_token } = await registerSeller(app);

      const results = await Promise.all([
        refresh(refresh_token),
        refresh(refresh_token),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    });

    it("keeps other sessions alive when one is revoked", async () => {
      const { seller, refresh_token: phone } = await registerSeller(app, {
        password: "two devices please",
      });
      const laptop = authResponseSchema.parse(
        (
          await post("/v1/auth/login", {
            email: seller.email,
            password: "two devices please",
          })
        ).json(),
      );

      await refresh(phone);
      await refresh(phone); // reuse: kills the phone's family only

      expect((await refresh(laptop.refresh_token)).statusCode).toBe(200);
    });

    it("rejects an expired refresh token", async () => {
      const { refresh_token, seller } = await registerSeller(app);
      await app.db
        .update(refreshTokens)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(refreshTokens.sellerId, seller.id));

      expect((await refresh(refresh_token)).statusCode).toBe(401);
    });

    it("rejects a token it never issued", async () => {
      expect((await refresh("made-up-token")).statusCode).toBe(401);
    });

    it("logout revokes the session", async () => {
      const { refresh_token } = await registerSeller(app);

      const res = await post("/v1/auth/logout", { refresh_token });

      expect(res.statusCode).toBe(204);
      expect((await refresh(refresh_token)).statusCode).toBe(401);
    });
  });
});
