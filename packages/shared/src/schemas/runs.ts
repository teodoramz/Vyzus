import { z } from 'zod';
import { RUN_TRIGGERS } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';
import { runStatusSchema, checkTypeSchema } from './checks.js';

export const runTriggerSchema = z.enum(RUN_TRIGGERS);

// Metrics are a loose jsonb bag whose shape depends on check type.
// uptime: { httpStatus, ttfbMs, dclMs, loadMs }; journey: { steps }.
export const runMetricsSchema = z.record(z.unknown()).nullable();

export const runSchema = z.object({
  id: uuidSchema,
  checkId: uuidSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema,
  startedAt: isoTimestamp,
  durationMs: z.number().int(),
  metrics: runMetricsSchema,
  errorMessage: z.string().nullable(),
  hasScreenshot: z.boolean(),
  hasTrace: z.boolean(),
  workerId: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const runListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: runStatusSchema.optional(),
  // Screenshot gallery pagination: only runs with a screenshot, so a page of
  // `limit` is always `limit` actual screenshots, not `limit` raw runs mostly
  // filtered away client-side.
  hasScreenshot: z.coerce.boolean().optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export const runListResponseSchema = z.object({
  runs: z.array(runSchema),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof runListResponseSchema>;

// ---- Runs merged across every check of an application (app detail's
// "all checks" run history table) ----

export const appRunSchema = runSchema.extend({
  checkName: z.string(),
  checkType: checkTypeSchema,
});
export type AppRun = z.infer<typeof appRunSchema>;

export const appRunListQuerySchema = runListQuerySchema.extend({
  checkId: uuidSchema.optional(),
});
export type AppRunListQuery = z.infer<typeof appRunListQuerySchema>;

export const appRunListResponseSchema = z.object({
  runs: z.array(appRunSchema),
  nextCursor: z.string().nullable(),
});
export type AppRunListResponse = z.infer<typeof appRunListResponseSchema>;
