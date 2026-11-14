import { NextResponse, type NextRequest } from "next/server";

import { ApiError, refreshSession } from "@/lib/api";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  writeSessionCookies,
} from "@/lib/session-cookies";

const PUBLIC_SELLER_PAGES = new Set(["/seller/login", "/seller/register"]);

/**
 * Keeps seller sessions alive. Server Components can read cookies but not set
 * them, so the access token is refreshed here, before the page renders: when
 * the short-lived access cookie has expired but the refresh cookie hasn't,
 * swap the refresh token for a new pair, store both, and pass the new cookies
 * on to the page in the same request.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_SELLER_PAGES.has(pathname)) return NextResponse.next();
  if (request.cookies.has(ACCESS_COOKIE)) return NextResponse.next();

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    let tokens;
    try {
      tokens = await refreshSession(refreshToken);
    } catch (err) {
      // Only a rejected token ends the session. If the API is unreachable,
      // keep the cookies and let the page show its error state.
      if (!(err instanceof ApiError && err.status === 401)) {
        console.error(err);
        return NextResponse.next();
      }
    }
    if (tokens) {
      // Updating request cookies rewrites the Cookie header that the page sees.
      request.cookies.set(ACCESS_COOKIE, tokens.access_token);
      request.cookies.set(REFRESH_COOKIE, tokens.refresh_token);
      const response = NextResponse.next({
        request: { headers: request.headers },
      });
      writeSessionCookies(response.cookies, tokens);
      return response;
    }
  }

  const login = new URL("/seller/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  const response = NextResponse.redirect(login);
  clearSessionCookies(response.cookies);
  return response;
}

export const config = {
  matcher: ["/seller/:path*"],
};
