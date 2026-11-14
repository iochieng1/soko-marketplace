import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { refreshTokens } from "../db/schema.js";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const newToken = () => randomBytes(32).toString("base64url");

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const insertToken = async (
  db: Database | Tx,
  sellerId: string,
  familyId: string,
  ttlDays: number,
) => {
  const token = newToken();
  await db.insert(refreshTokens).values({
    sellerId,
    familyId,
    tokenHash: hashToken(token),
    expiresAt: sql`now() + make_interval(days => ${ttlDays}::int)`,
  });
  return token;
};

/** Starts a new token family (one per login). */
export const issueRefreshToken = (
  db: Database,
  sellerId: string,
  ttlDays: number,
) => insertToken(db, sellerId, randomUUID(), ttlDays);

export type RotateResult =
  | { ok: true; sellerId: string; refreshToken: string }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused" };

/**
 * Exchanges a refresh token for its successor. The row is locked for the
 * duration, so two concurrent refreshes with the same token serialise: the
 * first rotates it, the second sees it used and is treated as reuse.
 */
export const rotateRefreshToken = (
  db: Database,
  token: string,
  ttlDays: number,
): Promise<RotateResult> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: refreshTokens.id,
        sellerId: refreshTokens.sellerId,
        familyId: refreshTokens.familyId,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
        expired: sql<boolean>`${refreshTokens.expiresAt} <= now()`,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .for("update");

    if (!row) return { ok: false, reason: "unknown" };
    if (row.revokedAt) return { ok: false, reason: "revoked" };

    if (row.usedAt) {
      // Reuse of a rotated token: assume theft and end the whole session.
      await revokeFamily(tx, row.familyId);
      return { ok: false, reason: "reused" };
    }

    if (row.expired) return { ok: false, reason: "expired" };

    await tx
      .update(refreshTokens)
      .set({ usedAt: sql`now()` })
      .where(eq(refreshTokens.id, row.id));

    const refreshToken = await insertToken(
      tx,
      row.sellerId,
      row.familyId,
      ttlDays,
    );
    return { ok: true, sellerId: row.sellerId, refreshToken };
  });

const revokeFamily = (db: Database | Tx, familyId: string) =>
  db
    .update(refreshTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
      ),
    );

/** Logout: revokes the session the token belongs to. Unknown tokens are a no-op. */
export const revokeRefreshToken = async (db: Database, token: string) => {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)));
  if (row) await revokeFamily(db, row.familyId);
};
