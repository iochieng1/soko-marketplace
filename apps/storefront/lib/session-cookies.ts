import type { TokenPair } from "@soko/shared";

/*
 * The seller's tokens live in httpOnly cookies set by the Next.js server, so
 * browser JavaScript (and any XSS) can never read them. The browser only ever
 * talks to Next.js; Next.js adds the Bearer token when it calls the API.
 */
export const ACCESS_COOKIE = "soko_at";
export const REFRESH_COOKIE = "soko_rt";

// Matches the API's REFRESH_TOKEN_TTL_DAYS default. If the cookie outlives the
// token, the next refresh fails and the seller is sent to log in.
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

const base = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

type CookieSetter = {
  set(
    name: string,
    value: string,
    options: typeof base & { maxAge: number },
  ): unknown;
};

export const writeSessionCookies = (
  cookies: CookieSetter,
  tokens: TokenPair,
) => {
  // Expire the access cookie a little before the token, so the proxy
  // refreshes it rather than the API rejecting a just-expired token.
  cookies.set(ACCESS_COOKIE, tokens.access_token, {
    ...base,
    maxAge: Math.max(tokens.expires_in - 30, 1),
  });
  cookies.set(REFRESH_COOKIE, tokens.refresh_token, {
    ...base,
    maxAge: REFRESH_MAX_AGE,
  });
};

export const clearSessionCookies = (cookies: {
  delete(name: string): unknown;
}) => {
  cookies.delete(ACCESS_COOKIE);
  cookies.delete(REFRESH_COOKIE);
};
