import { z } from 'zod';
import { uuidSchema } from './common.js';
import { runStatusSchema } from './checks.js';

// Server → client WebSocket events (04-api-spec §WebSocket), fed by Redis pub/sub.

export const wsRunFinishedSchema = z.object({
  type: z.literal('run.finished'),
  appId: uuidSchema,
  checkId: uuidSchema,
  runId: uuidSchema,
  status: runStatusSchema,
  durationMs: z.number().int(),
  hasScreenshot: z.boolean(),
});

export const wsIncidentOpenedSchema = z.object({
  type: z.literal('incident.opened'),
  appId: uuidSchema,
  checkId: uuidSchema,
  incidentId: uuidSchema,
});

export const wsIncidentResolvedSchema = z.object({
  type: z.literal('incident.resolved'),
  appId: uuidSchema,
  checkId: uuidSchema,
  incidentId: uuidSchema,
  downtimeSeconds: z.number().int(),
});

export const wsStatsUpdatedSchema = z.object({
  type: z.literal('stats.updated'),
  up: z.number().int(),
  down: z.number().int(),
  openIncidents: z.number().int(),
});

export const wsEventSchema = z.discriminatedUnion('type', [
  wsRunFinishedSchema,
  wsIncidentOpenedSchema,
  wsIncidentResolvedSchema,
  wsStatsUpdatedSchema,
]);
export type WsEvent = z.infer<typeof wsEventSchema>;
