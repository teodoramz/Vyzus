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

/** Unreserved local-part characters, per the practical subset of RFC 5322. */
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** A DNS label: alphanumeric, hyphens inside only. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * An email address.
 *
 * Deliberately not Zod's `.email()`, which requires the last domain label to be
 * letters only. That rejects `admin@host01.internal7` — a perfectly real address
 * on an internal network, where the domain is whatever the operator named it
 * and digits in the final label are ordinary. The public-suffix assumption only
 * holds on the public internet, and this product is self-hosted.
 *
 * Two labels are still required, so `admin@localhost` and a plain typo like
 * `admin@gmailcom` are caught.
 */
export function isEmailAddress(value: string): boolean {
  if (value.length > 320) return false;
  const at = value.lastIndexOf('@');
  if (at < 1) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length > 255) return false;
  if (!LOCAL.test(local)) return false;

  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

/** An email address, for the places that need a real mailbox. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().refine(isEmailAddress, { message: 'Must be a valid email address' }));

/** A stored address on the way out — already validated when it was written. */
export const storedEmailSchema = z.string().min(1);

/** Cursor pagination query shared by run listings. */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
