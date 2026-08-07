import { z } from 'zod';

/** Runtime-tunable retention settings (03-data-model `settings` table). */
export const settingsSchema = z.object({
  runsDays: z.number().int().min(1).max(3650),
  screenshotsDays: z.number().int().min(1).max(3650),
  tracesDays: z.number().int().min(1).max(3650),
  /** Dead-man's switch threshold in minutes; 0 disables it. */
  heartbeatStallMinutes: z.number().int().min(0).max(1440),
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsBodySchema = z
  .object({
    runsDays: z.number().int().min(1).max(3650).optional(),
    screenshotsDays: z.number().int().min(1).max(3650).optional(),
    tracesDays: z.number().int().min(1).max(3650).optional(),
    heartbeatStallMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty update' });
export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;
