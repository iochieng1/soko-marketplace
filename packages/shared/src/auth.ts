import { z } from "zod";

import { normalizeKenyanPhone } from "./phone.js";

const emailSchema = z.string().trim().max(254).pipe(z.email());

const phoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizeKenyanPhone(value);
  if (!phone) {
    ctx.addIssue({
      code: "custom",
      message: "Enter a Kenyan mobile number, e.g. 0712 345 678",
    });
    return z.NEVER;
  }
  return phone;
});

// argon2 has no input length limit like bcrypt's 72 bytes, but an unbounded
// password is a cheap way to make the server hash megabytes per request.
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const registerRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.input<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // No length rules on login: they would tell an attacker about the policy and
  // reject passwords set before a policy change.
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const sellerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Seller = z.infer<typeof sellerSchema>;

export const tokenPairSchema = z.object({
  token_type: z.literal("Bearer"),
  access_token: z.string().min(1),
  // Seconds until access_token expires.
  expires_in: z.number().int().positive(),
  // Single use: every refresh returns a new one and invalidates this one.
  refresh_token: z.string().min(1),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const authResponseSchema = tokenPairSchema.extend({
  seller: sellerSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;
