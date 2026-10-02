import { z } from 'zod';

/** Standard error envelope: `{ error: { code, message } }`. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const uuidSchema = z.string().uuid();

/** `:id` path params used by many routes. */
export const idParamSchema = z.object({ id: uuidSchema });
export type IdParam = z.infer<typeof idParamSchema>;

/** `:appId` path param for nested application routes. */
export const appIdParamSchema = z.object({ appId: uuidSchema });
export type AppIdParam = z.infer<typeof appIdParamSchema>;

export const isoTimestamp = z.string();

/** A username: letters, digits, and `. _ -` between them. No `@`. */
const USERNAME = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/**
 * How an account is identified at sign-in.
 *
 * Usually an email address, but not every deployment issues one — an internal
 * account can be a plain username like `host01.internal7`. Nothing ever sends
 * mail to this value (alerts go to a channel's own recipient list), so
 * demanding a domain locked those deployments out for no benefit.
 *
 * An entry containing `@` is still validated as an email, so an actual typo in
 * an address is caught rather than silently accepted as a username.
 */
export const accountIdentifierSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(3, 'Must be at least 3 characters')
      .max(320)
      .refine((v) => (v.includes('@') ? z.string().email().safeParse(v).success : USERNAME.test(v)), {
        message: 'Must be an email address or a username (letters, digits, dot, dash, underscore)',
      }),
  );

/** The same value on the way out — already validated when it was stored. */
export const accountIdentifierOutSchema = z.string().min(1);

/** Cursor pagination query shared by run listings. */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
