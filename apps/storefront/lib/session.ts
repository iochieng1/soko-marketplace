import "server-only";

import type { TokenPair } from "@soko/shared";
import { cookies } from "next/headers";

import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  writeSessionCookies,
} from "./session-cookies";

export const getAccessToken = async () =>
  (await cookies()).get(ACCESS_COOKIE)?.value;

export const getRefreshToken = async () =>
  (await cookies()).get(REFRESH_COOKIE)?.value;

/** Only callable from Server Actions and Route Handlers. */
export const saveSession = async (tokens: TokenPair) =>
  writeSessionCookies(await cookies(), tokens);

export const clearSession = async () => clearSessionCookies(await cookies());
