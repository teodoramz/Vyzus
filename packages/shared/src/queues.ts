// BullMQ queue names and job payload shapes (02-architecture §4).
// Producers (API scheduler / worker) and consumers (worker / API alerter)
// import these so a job's shape is defined exactly once.
import { z } from 'zod';
import { RUN_TRIGGERS, CHECK_TYPES } from './constants.js';

export const QUEUE_NAMES = {
  checks: 'checks',
  alerts: 'alerts',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Job priorities: on-demand jumps the line (lower number = higher priority).
export const JOB_PRIORITY = {
  onDemand: 1,
  scheduled: 5,
} as const;

/**
 * `checks` queue — API scheduler (repeatable + on-demand) → worker.
 * Spec payload is `{ checkId, trigger }`; `runId` is an optional
 * API-supplied id so run-now / screenshot endpoints can return a run id
 * before the worker has persisted the row (the worker uses it if present).
 */
export const checkJobPayloadSchema = z.object({
  checkId: z.string().uuid(),
  trigger: z.enum(RUN_TRIGGERS),
  runId: z.string().uuid().optional(),
});
export type CheckJobPayload = z.infer<typeof checkJobPayloadSchema>;

/**
 * `alerts` queue. Two producers: the worker's incident state machine sends
 * check alerts (carrying an incidentId), and the API's heartbeat sends
 * platform alerts, which have no incident because nothing ran to fail.
 */
export const checkAlertJobPayloadSchema = z.object({
  incidentId: z.string().uuid(),
  event: z.enum(['down', 'recovered']),
});

export const monitoringAlertJobPayloadSchema = z.object({
  event: z.enum(['stalled', 'resumed']),
  silentForSeconds: z.number().int().min(0),
  thresholdMinutes: z.number().int().min(0),
  lastRunAt: z.string().nullable(),
});

export const alertJobPayloadSchema = z.union([checkAlertJobPayloadSchema, monitoringAlertJobPayloadSchema]);
export type CheckAlertJobPayload = z.infer<typeof checkAlertJobPayloadSchema>;
export type MonitoringAlertJobPayload = z.infer<typeof monitoringAlertJobPayloadSchema>;
export type AlertJobPayload = z.infer<typeof alertJobPayloadSchema>;

/**
 * `maintenance` queue — API repeatables → API. `retention` runs daily;
 * `heartbeat` runs every minute and is the platform's dead-man's switch.
 */
export const maintenanceJobPayloadSchema = z.object({
  task: z.enum(['retention', 'heartbeat']),
});
export type MaintenanceJobPayload = z.infer<typeof maintenanceJobPayloadSchema>;

/**
 * Dry-run job (04-api-spec `POST /checks/dry-run`): the unsaved check config is
 * inlined in the payload; the worker executes once, persists nothing, and
 * returns the result as the BullMQ job return value which the API awaits.
 * `appId` supplies the landing URL / encrypted credentials for uptime checks.
 */
export const dryRunJobPayloadSchema = z.object({
  dryRun: z.literal(true),
  appId: z.string().uuid(),
  type: z.enum(CHECK_TYPES),
  config: z.unknown(),
  timeoutMs: z.number().int().min(1000).max(300_000),
});
export type DryRunJobPayload = z.infer<typeof dryRunJobPayloadSchema>;

/** Repeatable job id for a check's schedule (dedup key on the `checks` queue). */
export const checkRepeatableJobId = (checkId: string): string => `check:${checkId}`;

/** BullMQ job names on the `checks` queue (job name encodes the kind). */
export const CHECK_JOB_NAMES = {
  scheduled: 'scheduled-run',
  manual: 'manual-run',
  screenshot: 'screenshot-run',
  dryRun: 'dry-run',
} as const;

/** Redis pub/sub channel the worker publishes finished runs on. */
export const RUN_FINISHED_CHANNEL = 'run.finished';
/** Redis pub/sub channels for incident transitions (forwarded to WS clients). */
export const INCIDENT_OPENED_CHANNEL = 'incident.opened';
export const INCIDENT_RESOLVED_CHANNEL = 'incident.resolved';
