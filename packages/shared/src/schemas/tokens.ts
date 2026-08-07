import { z } from 'zod';
import { isoTimestamp, uuidSchema } from './common.js';

/**
 * API tokens for automation. The secret itself is returned exactly once, at
 * creation — only its hash is stored, so it can never be shown again.
 */
export const apiTokenSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp.nullable(),
  lastUsedAt: isoTimestamp.nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const apiTokenListSchema = z.array(apiTokenSchema);

export const createApiTokenBodySchema = z.object({
  name: z.string().min(1).max(200),
  /** Days until expiry. Omitted means the token never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiTokenBody = z.infer<typeof createApiTokenBodySchema>;

/** Creation response — the only time `token` is ever populated. */
export const createdApiTokenSchema = apiTokenSchema.extend({
  token: z.string(),
});
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;
