import { z } from 'zod';
import { APP_STATUSES, DEFAULT_INTERVAL_MINUTES } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';
import { checkWithAvailabilitySchema, runStatusSchema, checkTypeSchema } from './checks.js';

export const appStatusSchema = z.enum(APP_STATUSES);

/** Optional per-app credentials, encrypted at rest as auth_config_enc. */
/**
 * Form-based login for targets behind a normal session.
 *
 * Uptime checks support HTTP basic auth and custom headers, but a target behind
 * a login form renders as a login page (or an empty shell) to the checker, and
 * the screenshot captures nothing useful. This drives the real form in the same
 * browser context, so the session cookie it sets is carried into the check
 * itself — no storage-state serialisation needed.
 *
 * Lives inside `authConfig`, which is already encrypted at rest as
 * `applications.auth_config_enc` (AES-256-GCM), so the password reuses that
 * path rather than introducing a second secret store.
 */
export const sessionLoginSchema = z.object({
  loginUrl: z.string().url().max(2000),
  usernameSelector: z.string().min(1).max(500),
  passwordSelector: z.string().min(1).max(500),
  submitSelector: z.string().min(1).max(500),
  username: z.string().min(1).max(500),
  password: z.string().min(1).max(500),
  /**
   * Optional proof the login actually worked. Without it a failed login is
   * indistinguishable from a successful one until the check's own assertions
   * fail on the login page — with a confusing message.
   */
  successSelector: z.string().min(1).max(500).optional(),
});
export type SessionLogin = z.infer<typeof sessionLoginSchema>;

export const appAuthConfigSchema = z.object({
  basicAuth: z.object({ username: z.string(), password: z.string() }).optional(),
  headers: z.record(z.string()).optional(),
  sessionLogin: sessionLoginSchema.optional(),
});
export type AppAuthConfig = z.infer<typeof appAuthConfigSchema>;

export const createAppBodySchema = z.object({
  name: z.string().min(1).max(200),
  landingUrl: z.string().url().max(2000),
  tags: z.array(z.string().min(1).max(50)).max(50).default([]),
  authConfig: appAuthConfigSchema.nullable().optional(),
  enabled: z.boolean().default(true),
  /** Upstream this sits behind; its outage suppresses this app's alerts. */
  parentAppId: uuidSchema.nullable().default(null),
  /** Show on the public status page. Off by default — opting in is deliberate. */
  isPublic: z.boolean().default(false),
  // interval for the auto-created primary uptime check
  intervalMinutes: z.number().int().min(1).default(DEFAULT_INTERVAL_MINUTES),
  /**
   * Create the starter set of checks (uptime + DNS + TLS, as applicable).
   * Set false when something else owns this application's checks — notably
   * `scripts/sync-targets.mjs --prune`, which deletes any check not named in
   * the target files and would otherwise remove these on the next run.
   */
  createDefaultChecks: z.boolean().default(true),
});
export type CreateAppBody = z.infer<typeof createAppBodySchema>;

export const updateAppBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    landingUrl: z.string().url().max(2000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(50).optional(),
    authConfig: appAuthConfigSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    parentAppId: uuidSchema.nullable().optional(),
    isPublic: z.boolean().optional(),
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
  parentAppId: uuidSchema.nullable(),
  isPublic: z.boolean(),
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
