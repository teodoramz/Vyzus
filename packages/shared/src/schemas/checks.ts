import { z } from 'zod';
import {
  CHECK_TYPES,
  RUN_STATUSES,
  SCREENSHOT_MODES,
  UPTIME_MODES,
  PORT_PROTOCOLS,
  IP_FAMILIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
  JOURNEY_SPEC_MAX_BYTES,
  DEFAULT_PUSH_GRACE_MINUTES,
} from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';

export const checkTypeSchema = z.enum(CHECK_TYPES);
export const runStatusSchema = z.enum(RUN_STATUSES);
export const screenshotModeSchema = z.enum(SCREENSHOT_MODES);
export const uptimeModeSchema = z.enum(UPTIME_MODES);
export const portProtocolSchema = z.enum(PORT_PROTOCOLS);
export const ipFamilySchema = z.enum(IP_FAMILIES);

// ---- Per-type check config (stored in checks.config jsonb) ----

// Config schemas are `.strict()` so the type-less update union
// (uptime | journey) can be disambiguated by key shape and so typos are caught.

// `uptime` isn't web-only: it's "is the thing itself reachable," and that
// covers both an HTTP(S) service (the original browser-based check) and a
// raw TCP/UDP port. Both modes share the check type, drive the app's
// Up/Down badge identically, and just differ in config shape + executor.
export const httpModeConfigSchema = z
  .object({
    mode: z.literal('http'),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    selector: z.string().min(1).max(1000).optional(),
    bodyText: z.string().min(1).max(2000).optional(),
    // Substring match against document.title — e.g. paste the landing page's
    // actual <title> so a check fails if it ever silently changes (a
    // maintenance page, a misconfigured deploy serving the wrong app, etc.).
    title: z.string().min(1).max(500).optional(),
    screenshot: screenshotModeSchema.default('on_change'),
    // Only meaningful for `on_change` / `on_failure`: also refresh the stored
    // screenshot on a *passing* run once the current one is older than this,
    // so a healthy check still shows what the site looks like today rather
    // than whatever it looked like at the last incident. Unset means no
    // periodic refresh (failures/recoveries only). Capped at a week.
    screenshotRefreshMinutes: z.number().int().min(1).max(10080).optional(),
    // Fail a run that returns the expected status but took longer than this.
    // "Up but badly degraded" is otherwise invisible: a check passes however
    // slow it was, so a site crawling at 20s looks identical to a healthy one.
    // 0 disables it, which is the default — enabling it by fiat would flip
    // existing checks to failing based on a number nobody chose.
    // Measured from navigation start through the last assertion, and recorded
    // as `responseMs` in the run metrics. Deliberately excludes screenshot
    // capture — that is the platform's own overhead, and a threshold tripped by
    // a slow PNG encode would be a false alarm.
    maxDurationMs: z.number().int().min(0).max(300_000).default(0),
    // Visual regression: fail when this percentage of pixels or more changed
    // against the previous stored screenshot of the same check. Catches
    // defacement, broken CSS and blank-page deploys that still return HTTP
    // 200 — failures no status-code or selector assertion can see.
    //
    // 0 disables it, which is the default. A percentage rather than a pixel
    // count so the number means the same thing at any viewport size. Requires
    // a screenshot mode that actually captures on passing runs (`always`, or
    // `on_change`/`on_failure` with a refresh cadence); with nothing to compare
    // against, the check simply passes.
    visualDiffPercent: z.number().min(0).max(100).default(0),
  })
  .strict();
export type HttpModeConfig = z.infer<typeof httpModeConfigSchema>;

export const portModeConfigSchema = z
  .object({
    mode: z.literal('port'),
    // Domain name or IPv4/IPv6 literal — deliberately not a URL: no scheme,
    // no path. net.connect()/dgram resolve either form transparently.
    host: z
      .string()
      .min(1)
      .max(255)
      .refine((h) => !h.includes('://') && !h.includes('/'), {
        message: 'Host only — no scheme or path (e.g. "example.com", not "https://example.com")',
      }),
    port: z.number().int().min(1).max(65535),
    protocol: portProtocolSchema.default('tcp'),
    family: ipFamilySchema.default('auto'),
    // Wraps the TCP connection in a TLS handshake and checks the
    // certificate (chain trust + expiry + hostname) — TCP only.
    tls: z.boolean().default(false),
    // Default (false): an invalid cert — expired, self-signed, untrusted CA,
    // hostname mismatch — fails the check exactly like a closed port. true:
    // the handshake completing is all that's checked; cert details are
    // still reported in metrics, just not enforced. For a deliberately
    // self-signed internal service, not for "I'll fix it later."
    allowInsecureCert: z.boolean().default(false),
    // Fail the check while the certificate is still valid but within this many
    // days of expiring, so a renewal has a window to happen in. 0 disables it,
    // which is the default — otherwise enabling this feature would retroactively
    // change the verdict of every existing TLS check.
    //
    // Without it a certificate only fails once it has *already* expired, which
    // is precisely too late. Applies whether or not allowInsecureCert is set: a
    // self-signed certificate expires just like a public one.
    certExpiryWarningDays: z.number().int().min(0).max(365).default(0),
  })
  .strict();
export type PortModeConfig = z.infer<typeof portModeConfigSchema>;

// Configs stored before the http/port split (or built by hand) may omit
// `mode` entirely — they're implicitly HTTP. Stamped on before the
// discriminated union runs so old rows validate with no data migration.
// The tls+protocol cross-check has to live on the *outer* refine, not
// inside portModeConfigSchema: discriminatedUnion requires each member to
// stay a plain ZodObject (readable `.shape`) to resolve the discriminant,
// and `.refine()` on a member would wrap it in a ZodEffects instead.
export const uptimeConfigSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('mode' in val) ? { mode: 'http', ...val } : val),
  z
    .discriminatedUnion('mode', [httpModeConfigSchema, portModeConfigSchema])
    .refine((v) => !(v.mode === 'port' && v.tls && v.protocol === 'udp'), {
      message: 'TLS is only supported over TCP',
      path: ['tls'],
    }),
);
export type UptimeConfig = z.infer<typeof uptimeConfigSchema>;

/**
 * `push` — a heartbeat the monitored job sends to Vyzus, rather than a target
 * Vyzus reaches out to. Covers everything not reachable from the monitor: cron
 * jobs, backup scripts, batch imports, hosts behind NAT.
 */
export const pushConfigSchema = z
  .object({
    /**
     * Opaque secret in the ping URL. This is the only credential on the
     * endpoint — it is necessarily unauthenticated, because the whole point is
     * that a shell script can curl it with no setup.
     */
    token: z.string().min(16).max(128),
    /**
     * Extra slack beyond the check's interval before a missing ping fails. A
     * job on a 5-minute cron will not land exactly on the mark.
     */
    graceMinutes: z.number().int().min(0).max(1440).default(DEFAULT_PUSH_GRACE_MINUTES),
  })
  .strict();
export type PushConfig = z.infer<typeof pushConfigSchema>;

export const journeyConfigSchema = z
  .object({
    specSource: z
      .string()
      .min(1)
      // TextEncoder (not Buffer) so this schema — imported by both the Node
      // API and the browser dashboard — works isomorphically in both.
      .refine((s) => new TextEncoder().encode(s).length <= JOURNEY_SPEC_MAX_BYTES, {
        message: `Journey spec must be <= ${JOURNEY_SPEC_MAX_BYTES} bytes`,
      }),
  })
  .strict();
export type JourneyConfig = z.infer<typeof journeyConfigSchema>;

/** Discriminated union of a check's type + its config, used for create/update. */
export const checkConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uptime'), config: uptimeConfigSchema }),
  z.object({ type: z.literal('journey'), config: journeyConfigSchema }),
  z.object({ type: z.literal('push'), config: pushConfigSchema }),
]);
export type CheckConfig = z.infer<typeof checkConfigSchema>;

const intervalMinutesSchema = z.number().int().min(1);

// ---- Request bodies ----

// Base check attributes shared by create/update (excluding type/config which
// are validated together as a discriminated union).
const checkBaseFields = {
  name: z.string().min(1).max(200),
  intervalMinutes: intervalMinutesSchema,
  timeoutMs: z.number().int().min(1000).max(300_000).default(DEFAULT_TIMEOUT_MS),
  failureThreshold: z.number().int().min(1).max(20).default(DEFAULT_FAILURE_THRESHOLD),
  enabled: z.boolean().default(true),
};

export const createCheckBodySchema = z.intersection(z.object(checkBaseFields), checkConfigSchema);
export type CreateCheckBody = z.infer<typeof createCheckBodySchema>;

// Update: everything optional. `config` (when present) is re-validated in the
// route against the check's target type; changing `type` requires a `config`.
export const updateCheckBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    intervalMinutes: intervalMinutesSchema.optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    failureThreshold: z.number().int().min(1).max(20).optional(),
    enabled: z.boolean().optional(),
    type: checkTypeSchema.optional(),
    config: z.union([uptimeConfigSchema, journeyConfigSchema, pushConfigSchema]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty update' })
  .refine((v) => !(v.type !== undefined && v.config === undefined), {
    message: 'When changing type you must also supply a matching config',
  });
export type UpdateCheckBody = z.infer<typeof updateCheckBodySchema>;

// ---- Responses ----

export const checkSchema = z.object({
  id: uuidSchema,
  appId: uuidSchema,
  type: checkTypeSchema,
  name: z.string(),
  intervalMinutes: z.number().int(),
  timeoutMs: z.number().int(),
  failureThreshold: z.number().int(),
  enabled: z.boolean(),
  config: z.union([uptimeConfigSchema, journeyConfigSchema, pushConfigSchema]),
  consecutiveFailures: z.number().int(),
  lastStatus: runStatusSchema.nullable(),
  lastRunAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Check = z.infer<typeof checkSchema>;

/**
 * Check enriched with availability windows for the app-detail page.
 * Availability values are a 0..1 fraction (passed runs / total runs) over the
 * window, or null when the check has no runs in it.
 */
export const checkWithAvailabilitySchema = checkSchema.extend({
  availability24h: z.number().nullable().describe('0..1 fraction of passed runs in the last 24h'),
  availability7d: z.number().nullable().describe('0..1 fraction of passed runs in the last 7d'),
  availability30d: z.number().nullable().describe('0..1 fraction of passed runs in the last 30d'),
});
export type CheckWithAvailability = z.infer<typeof checkWithAvailabilitySchema>;

export const checkListSchema = z.array(checkSchema);

/** PUT /apps/:appId/checks/order — must contain exactly the app's check ids. */
export const reorderChecksBodySchema = z.object({
  checkIds: z.array(uuidSchema).min(1),
});
export type ReorderChecksBody = z.infer<typeof reorderChecksBodySchema>;

/** 202 response for run-now / on-demand screenshot. */
export const enqueuedRunResponseSchema = z.object({ runId: uuidSchema });
export type EnqueuedRunResponse = z.infer<typeof enqueuedRunResponseSchema>;

// ---- Dry run (POST /checks/dry-run) ----

/** Body: full unsaved check config; appId supplies target URL + credentials. */
export const dryRunBodySchema = z.intersection(
  z.object({
    appId: uuidSchema,
    timeoutMs: z.number().int().min(1000).max(300_000).default(DEFAULT_TIMEOUT_MS),
  }),
  checkConfigSchema,
);
export type DryRunBody = z.infer<typeof dryRunBodySchema>;

/** Result of a single check execution, returned inline (never persisted). */
export const dryRunResultSchema = z.object({
  status: runStatusSchema,
  durationMs: z.number().int(),
  metrics: z.record(z.unknown()).nullable(),
  errorMessage: z.string().nullable(),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;
