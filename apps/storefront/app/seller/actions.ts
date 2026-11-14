"use server";

import {
  createProductRequestSchema,
  loginRequestSchema,
  productStatusSchema,
  registerRequestSchema,
  updateProductRequestSchema,
} from "@soko/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import * as api from "@/lib/api";
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  saveSession,
} from "@/lib/session";

export type FormState = { error?: string; ok?: boolean };

const firstIssue = (error: { issues: { message: string }[] }) =>
  error.issues[0]?.message ?? "Check the form and try again";

/** Only same-site relative paths, so ?next= can't redirect off-site. */
const safeNext = (next: FormDataEntryValue | null) =>
  typeof next === "string" &&
  next.startsWith("/seller/") &&
  !next.startsWith("//")
    ? next
    : "/seller/products";

const messageFor = (err: unknown, known: Record<string, string> = {}) => {
  if (err instanceof api.ApiError) {
    if (err.code && known[err.code]) return known[err.code];
    if (err.status === 400) return err.message;
  }
  console.error(err);
  return "Something went wrong. Please try again.";
};

export async function loginAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const body = loginRequestSchema.safeParse({
    email: form.get("email"),
    password: form.get("password"),
  });
  if (!body.success) return { error: "Enter your email and password" };

  try {
    await saveSession(await api.login(body.data));
  } catch (err) {
    return {
      error: messageFor(err, {
        INVALID_CREDENTIALS: "Email or password is incorrect",
      }),
    };
  }
  redirect(safeNext(form.get("next")));
}

export async function registerAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const body = registerRequestSchema.safeParse({
    name: form.get("name"),
    email: form.get("email"),
    phone: form.get("phone"),
    password: form.get("password"),
  });
  if (!body.success) return { error: firstIssue(body.error) };

  try {
    // The schema normalised the phone; the API accepts that form too.
    await saveSession(await api.register(body.data));
  } catch (err) {
    return {
      error: messageFor(err, {
        EMAIL_TAKEN:
          "An account with this email already exists. Log in instead.",
      }),
    };
  }
  redirect("/seller/products");
}

export async function logoutAction() {
  const refreshToken = await getRefreshToken();
  if (refreshToken) await api.logout(refreshToken).catch(() => undefined);
  await clearSession();
  redirect("/seller/login");
}

const requireToken = async () => {
  const token = await getAccessToken();
  if (!token) redirect("/seller/login");
  return token;
};

/** On a 401 the session is gone (revoked, or the user was deleted). */
const handleWriteError = async (
  err: unknown,
  known: Record<string, string> = {},
): Promise<FormState> => {
  if (err instanceof api.ApiError && err.status === 401) {
    await clearSession();
    redirect("/seller/login");
  }
  return { error: messageFor(err, known) };
};

export async function createProductAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const token = await requireToken();
  const body = createProductRequestSchema.safeParse({
    title: form.get("title"),
    description: form.get("description") ?? "",
    price: form.get("price"),
    on_hand: form.get("on_hand") || 0,
    status: form.get("publish") === "on" ? "ACTIVE" : "DRAFT",
  });
  if (!body.success) return { error: firstIssue(body.error) };

  try {
    await api.createProduct(token, body.data);
  } catch (err) {
    return handleWriteError(err);
  }
  revalidatePath("/seller/products");
  return { ok: true };
}

export async function updateProductAction(
  id: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const token = await requireToken();
  const status = productStatusSchema.safeParse(form.get("status"));
  const body = updateProductRequestSchema.safeParse({
    price: form.get("price") ?? undefined,
    on_hand: form.get("on_hand") ?? undefined,
    status: status.success ? status.data : undefined,
  });
  if (!body.success) return { error: firstIssue(body.error) };

  try {
    await api.updateProduct(token, id, body.data);
  } catch (err) {
    return handleWriteError(err, {
      STOCK_BELOW_RESERVED:
        "Stock can't go below what's reserved by unpaid orders",
      NOT_FOUND: "This product no longer exists",
    });
  }
  revalidatePath("/seller/products");
  return { ok: true };
}
