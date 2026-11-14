import {
  authResponseSchema,
  errorResponseSchema,
  productDetailSchema,
  productListResponseSchema,
  sellerProductListResponseSchema,
  sellerProductSchema,
  sellerSchema,
  tokenPairSchema,
  type AuthResponse,
  type CreateProductRequest,
  type LoginRequest,
  type ProductDetail,
  type ProductListResponse,
  type RegisterRequest,
  type Seller,
  type SellerProduct,
  type SellerProductListResponse,
  type TokenPair,
  type UpdateProductRequest,
} from "@soko/shared";
import type { z } from "zod";

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    message: string,
    /** HTTP status, when the API answered at all. */
    readonly status?: number,
    /** The API's machine-readable error code, e.g. "EMAIL_TAKEN". */
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const apiBaseUrl = (): string => {
  const url = process.env.API_BASE_URL;
  if (!url) throw new ApiError("API_BASE_URL is not set");
  return url.replace(/\/+$/, "");
};

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  token?: string;
  query?: Record<string, string | undefined>;
};

/** Calls the Soko API and validates the response against the shared contract. */
const request = async <S extends z.ZodType>(
  path: string,
  schema: S | null,
  { method = "GET", body, token, query }: RequestOptions = {},
): Promise<z.infer<S>> => {
  const url = new URL(`${apiBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    throw new ApiError("Could not reach the Soko API", undefined, undefined, {
      cause: err,
    });
  }

  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(
      await res.json().catch(() => null),
    );
    throw new ApiError(
      parsed.success
        ? parsed.data.error.message
        : `Soko API responded with ${res.status}`,
      res.status,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }

  if (schema === null) return undefined as z.infer<S>;

  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new ApiError("Soko API returned an unexpected response shape");
  }
  return parsed.data;
};

// Public catalogue

export const fetchProducts = (params: {
  cursor?: string;
  q?: string;
}): Promise<ProductListResponse> =>
  request("/v1/products", productListResponseSchema, { query: params });

/** null when the product doesn't exist or isn't for sale. */
export const fetchProduct = async (
  slug: string,
): Promise<ProductDetail | null> => {
  try {
    return await request(
      `/v1/products/${encodeURIComponent(slug)}`,
      productDetailSchema,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
};

// Seller auth

export const login = (body: LoginRequest): Promise<AuthResponse> =>
  request("/v1/auth/login", authResponseSchema, { method: "POST", body });

export const register = (body: RegisterRequest): Promise<AuthResponse> =>
  request("/v1/auth/register", authResponseSchema, { method: "POST", body });

export const refreshSession = (refreshToken: string): Promise<TokenPair> =>
  request("/v1/auth/refresh", tokenPairSchema, {
    method: "POST",
    body: { refresh_token: refreshToken },
  });

export const logout = async (refreshToken: string): Promise<void> => {
  await request("/v1/auth/logout", null, {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
};

export const fetchMe = (token: string): Promise<Seller> =>
  request("/v1/auth/me", sellerSchema, { token });

// Seller catalogue

export const fetchSellerProducts = (
  token: string,
  cursor?: string,
): Promise<SellerProductListResponse> =>
  request("/v1/seller/products", sellerProductListResponseSchema, {
    token,
    query: { cursor, limit: "50" },
  });

export const createProduct = (
  token: string,
  body: CreateProductRequest,
): Promise<SellerProduct> =>
  request("/v1/seller/products", sellerProductSchema, {
    method: "POST",
    token,
    body,
  });

export const updateProduct = (
  token: string,
  id: string,
  body: UpdateProductRequest,
): Promise<SellerProduct> =>
  request(
    `/v1/seller/products/${encodeURIComponent(id)}`,
    sellerProductSchema,
    {
      method: "PATCH",
      token,
      body,
    },
  );
