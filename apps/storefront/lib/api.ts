import {
  productListResponseSchema,
  type ProductListResponse,
} from "@soko/shared";

export class ApiError extends Error {
  override name = "ApiError";
}

const apiBaseUrl = (): string => {
  const url = process.env.API_BASE_URL;
  if (!url) throw new ApiError("API_BASE_URL is not set");
  return url.replace(/\/+$/, "");
};

/** Fetches a page of active products and validates it against the shared contract. */
export const fetchProducts = async (
  cursor?: string,
): Promise<ProductListResponse> => {
  const url = new URL(`${apiBaseUrl()}/v1/products`);
  if (cursor) url.searchParams.set("cursor", cursor);

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    throw new ApiError("Could not reach the Soko API", { cause: err });
  }

  if (!res.ok) {
    throw new ApiError(`Soko API responded with ${res.status}`);
  }

  const parsed = productListResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new ApiError("Soko API returned an unexpected response shape");
  }
  return parsed.data;
};
