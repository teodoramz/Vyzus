import { z } from 'zod';
import { isoTimestamp, uuidSchema } from './common.js';

export const maintenanceWindowSchema = z.object({
  id: uuidSchema,
  /** null = platform-wide. */
  appId: uuidSchema.nullable(),
  appName: z.string().nullable(),
  reason: z.string(),
  startsAt: isoTimestamp,
  endsAt: isoTimestamp,
  createdBy: uuidSchema.nullable(),
  createdByEmail: z.string().nullable(),
  createdAt: isoTimestamp,
  /** Derived server-side so every client agrees on "now". */
  active: z.boolean(),
});
export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

export const maintenanceWindowListSchema = z.array(maintenanceWindowSchema);

export const createMaintenanceWindowBodySchema = z
  .object({
    appId: uuidSchema.nullable().default(null),
    reason: z.string().min(1).max(500),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type CreateMaintenanceWindowBody = z.infer<typeof createMaintenanceWindowBodySchema>;
