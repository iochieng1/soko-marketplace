"use client";

import type { SellerProduct } from "@soko/shared";
import { useActionState, useEffect, useRef } from "react";

import {
  createProductAction,
  loginAction,
  registerAction,
  updateProductAction,
  type FormState,
} from "./actions";

const input =
  "mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none";
const button =
  "rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50";

function FormError({ state }: { state: FormState }) {
  return state.error ? (
    <p role="alert" className="text-sm text-red-700">
      {state.error}
    </p>
  ) : null;
}

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <input className={input} {...props} />
    </label>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next ?? ""} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <FormError state={state} />
      <button className={`${button} w-full`} disabled={pending}>
        {pending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field
        label="Shop name"
        name="name"
        autoComplete="organization"
        required
        maxLength={100}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="M-Pesa phone number"
        name="phone"
        type="tel"
        autoComplete="tel"
        placeholder="0712 345 678"
        required
      />
      <Field
        label="Password (8+ characters)"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
      />
      <FormError state={state} />
      <button className={`${button} w-full`} disabled={pending}>
        {pending ? "Creating account…" : "Create seller account"}
      </button>
    </form>
  );
}

export function NewProductForm() {
  const [state, action, pending] = useActionState(createProductAction, {});
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form
      ref={form}
      action={action}
      className="grid gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2"
    >
      <div className="sm:col-span-2">
        <Field label="Title" name="title" required maxLength={120} />
      </div>
      <label className="block text-sm font-medium text-stone-700 sm:col-span-2">
        Description
        <textarea
          name="description"
          rows={2}
          maxLength={5000}
          className={input}
        />
      </label>
      <Field
        label="Price (KES)"
        name="price"
        type="number"
        min={1}
        max={250000}
        step={1}
        required
      />
      <Field
        label="Stock"
        name="on_hand"
        type="number"
        min={0}
        step={1}
        defaultValue={0}
      />
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" name="publish" /> Publish now (otherwise saved as
        a draft)
      </label>
      <div className="flex items-center justify-end gap-3">
        <FormError state={state} />
        <button className={button} disabled={pending}>
          {pending ? "Adding…" : "Add product"}
        </button>
      </div>
    </form>
  );
}

const statusLabel = { DRAFT: "Draft", ACTIVE: "Active", ARCHIVED: "Archived" };

export function ProductRow({ product }: { product: SellerProduct }) {
  const [state, action, pending] = useActionState(
    updateProductAction.bind(null, product.id),
    {},
  );

  return (
    <tr className="border-t border-stone-200 align-top">
      <td className="py-3 pr-4">
        <p className="font-medium">{product.title}</p>
        <p className="text-xs text-stone-500">/{product.slug}</p>
        <FormError state={state} />
      </td>
      <td colSpan={4} className="py-3">
        <form action={action} className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-stone-600">
            Price (KES)
            <input
              name="price"
              type="number"
              min={1}
              max={250000}
              step={1}
              defaultValue={product.price}
              className={`${input} w-28`}
            />
          </label>
          <label className="text-xs text-stone-600">
            Stock
            <input
              name="on_hand"
              type="number"
              min={product.reserved}
              step={1}
              defaultValue={product.on_hand}
              className={`${input} w-24`}
            />
          </label>
          <label className="text-xs text-stone-600">
            Status
            <select
              name="status"
              defaultValue={product.status}
              className={`${input} w-32`}
            >
              {Object.entries(statusLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className={button} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
          <span className="pb-2 text-xs text-stone-500">
            {product.reserved > 0
              ? `${product.reserved} reserved · ${product.available} available`
              : `${product.available} available`}
          </span>
        </form>
      </td>
    </tr>
  );
}
