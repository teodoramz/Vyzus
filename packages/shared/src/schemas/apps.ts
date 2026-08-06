import { z } from 'zod';
import { APP_STATUSES, DEFAULT_INTERVAL_MINUTES } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';
import { checkWithAvailabilitySchema, runStatusSchema, checkTypeSchema } from './checks.js';

export const appStatusSchema = z.enum(APP_STATUSES);

/** Optional per-app credentials, encrypted at rest as auth_config_enc. */
export const appAuthConfigSchema = z.object({
  basicAuth: z.object({ username: z.string(), password: z.string() }).optional(),
  headers: z.record(z.string()).optional(),
});
export type AppAuthConfig = z.infer<typeof appAuthConfigSchema>;

export const createAppBodySchema = z.object({
  name: z.string().min(1).max(200),
  landingUrl: z.string().url().max(2000),
  tags: z.array(z.string().min(1).max(50)).max(50).default([]),
  authConfig: appAuthConfigSchema.nullable().optional(),
  enabled: z.boolean().default(true),
  // interval for the auto-created default uptime check
  intervalMinutes: z.number().int().min(1).default(DEFAULT_INTERVAL_MINUTES),
});
export type CreateAppBody = z.infer<typeof createAppBodySchema>;

export const updateAppBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    landingUrl: z.string().url().max(2000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(50).optional(),
    authConfig: appAuthConfigSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty update' });
export type UpdateAppBody = z.infer<typeof updateAppBodySchema>;

/** Whether the app has stored credentials — never returns the secret itself. */
export const appSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  landingUrl: z.string(),
  tags: z.array(z.string()),
  hasAuthConfig: z.boolean(),
  enabled: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type App = z.infer<typeof appSchema>;

/** List item on the overview grid with embedded summary. */
export const appSummarySchema = appSchema.extend({
  status: appStatusSchema,
  /** Availability over the last 24h as a 0..1 fraction (passed/total), or null if no runs. */
  availability24h: z.number().nullable().describe('0..1 fraction of passed runs in the last 24h'),
  lastRun: isoTimestamp.nullable(),
  lastStatus: runStatusSchema.nullable(),
  checksCount: z.number().int(),
  latestScreenshotRunId: uuidSchema.nullable(),
  // ---- Overview-grid embeds (Phase 7): avoid N+1 checks/runs fetches per card.
  /** Duration (ms) of the app's most recent run, or null. */
  lastResponseTimeMs: z.number().nullable().optional(),
  /** Recent run durations (ms), oldest→newest, for the card sparkline. */
  recentDurationsMs: z.array(z.number()).optional(),
  /** Per-check latest status, so the grid needs no follow-up per-check fetch. */
  checkStatuses: z
    .array(
      z.object({
        id: uuidSchema,
        type: checkTypeSchema,
        lastStatus: runStatusSchema.nullable(),
      }),
    )
    .optional(),
});
export type AppSummary = z.infer<typeof appSummarySchema>;

export const appListSchema = z.array(appSummarySchema);

/** Full app detail including its checks with availability windows. */
export const appDetailSchema = appSchema.extend({
  status: appStatusSchema,
  checks: z.array(checkWithAvailabilitySchema),
});
export type AppDetail = z.infer<typeof appDetailSchema>;

export const listAppsQuerySchema = z.object({
  tag: z.string().optional(),
  status: appStatusSchema.optional(),
});
export type ListAppsQuery = z.infer<typeof listAppsQuerySchema>;
