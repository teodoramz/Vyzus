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

/** Cursor pagination query shared by run listings. */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
