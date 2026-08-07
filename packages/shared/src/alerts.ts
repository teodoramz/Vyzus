// Outbound alert webhook payload (04-api-spec §"Alert webhook payloads").
// The generic `webhook` channel receives this JSON; slack/discord channels
// receive the same information rendered as Block Kit / embed messages.
import { z } from 'zod';
import { CHECK_TYPES, RUN_STATUSES } from './constants.js';

export const checkAlertWebhookPayloadSchema = z.object({
  event: z.enum(['check.down', 'check.recovered']),
  application: z.object({
    id: z.string().uuid(),
    name: z.string(),
    landingUrl: z.string(),
  }),
  check: z.object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.enum(CHECK_TYPES),
  }),
  incident: z.object({
    id: z.string().uuid(),
    openedAt: z.string(),
    resolvedAt: z.string().nullable(),
    downtimeSeconds: z.number().nullable(),
  }),
  run: z.object({
    id: z.string().uuid(),
    status: z.enum(RUN_STATUSES),
    errorMessage: z.string().nullable(),
    screenshotUrl: z.string().nullable(),
  }),
  timestamp: z.string(),
});

/**
 * Platform-level alert from the dead-man's switch. It carries no application,
 * check, incident or run because the whole point is that nothing ran — the
 * monitoring stopped producing results.
 */
export const monitoringAlertWebhookPayloadSchema = z.object({
  event: z.enum(['monitoring.stalled', 'monitoring.resumed']),
  monitoring: z.object({
    /** Last run that finished anywhere on the platform, null if none ever. */
    lastRunAt: z.string().nullable(),
    silentForSeconds: z.number().int(),
    /** Threshold actually applied, after the shortest-interval guard. */
    thresholdMinutes: z.number().int(),
  }),
  timestamp: z.string(),
});

export const alertWebhookPayloadSchema = z.union([checkAlertWebhookPayloadSchema, monitoringAlertWebhookPayloadSchema]);

export type CheckAlertWebhookPayload = z.infer<typeof checkAlertWebhookPayloadSchema>;
export type MonitoringAlertWebhookPayload = z.infer<typeof monitoringAlertWebhookPayloadSchema>;
export type AlertWebhookPayload = z.infer<typeof alertWebhookPayloadSchema>;

/** Narrows the union without repeating the event literals at every call site. */
export function isMonitoringAlert(p: AlertWebhookPayload): p is MonitoringAlertWebhookPayload {
  return p.event === 'monitoring.stalled' || p.event === 'monitoring.resumed';
}

/** Header carrying the HMAC-SHA256 signature when a webhook channel has a secret. */
export const ALERT_SIGNATURE_HEADER = 'X-Vyzus-Signature';
