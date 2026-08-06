import { z } from 'zod';
import { USER_ROLES } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';

export const roleSchema = z.enum(USER_ROLES);

/** Public user shape (never includes password/refresh hashes). */
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  role: roleSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type User = z.infer<typeof userSchema>;

export const passwordSchema = z.string().min(8).max(200);

export const createUserBodySchema = z.object({
  email: z.string().email().toLowerCase(),
  password: passwordSchema,
  role: roleSchema,
});
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

export const updateUserBodySchema = z
  .object({
    role: roleSchema.optional(),
    password: passwordSchema.optional(),
  })
  .refine((v) => v.role !== undefined || v.password !== undefined, {
    message: 'At least one of role or password must be provided',
  });
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export const userListSchema = z.array(userSchema);

// ---- Viewer app assignment (GET/PUT /users/:id/apps, admin-only) ----
export const userAppAccessSchema = z.object({
  appIds: z.array(uuidSchema),
});
export type UserAppAccess = z.infer<typeof userAppAccessSchema>;
