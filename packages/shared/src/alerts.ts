// Outbound alert webhook payload (04-api-spec §"Alert webhook payloads").
// The generic `webhook` channel receives this JSON; slack/discord channels
// receive the same information rendered as Block Kit / embed messages.
import { z } from 'zod';
import { CHECK_TYPES, RUN_STATUSES } from './constants.js';

export const alertWebhookPayloadSchema = z.object({
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

export type AlertWebhookPayload = z.infer<typeof alertWebhookPayloadSchema>;

/** Header carrying the HMAC-SHA256 signature when a webhook channel has a secret. */
export const ALERT_SIGNATURE_HEADER = 'X-Vyzus-Signature';
