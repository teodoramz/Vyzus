import { z } from 'zod';
import { userSchema, passwordSchema } from './users.js';

export const loginBodySchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  user: userSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshResponseSchema = z.object({
  accessToken: z.string(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

// ---- First-boot setup ----

/** GET /auth/setup-status — unauthenticated; drives the setup-vs-login screen.
 * `needsSetup` is true only while the users table is completely empty. */
export const setupStatusResponseSchema = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

/** POST /auth/setup — creates the very first admin. Unauthenticated by
 * necessity (there is nobody to authenticate as yet), so the route is hard
 * -gated on the users table being empty and returns 409 otherwise. */
export const setupBodySchema = z.object({
  email: z.string().email().toLowerCase(),
  password: passwordSchema,
});
export type SetupBody = z.infer<typeof setupBodySchema>;
