import { z } from 'zod';
import { isoTimestamp, uuidSchema } from './common.js';

export const incidentSchema = z.object({
  id: uuidSchema,
  checkId: uuidSchema,
  openedAt: isoTimestamp,
  resolvedAt: isoTimestamp.nullable(),
  openingRunId: uuidSchema.nullable(),
  resolvingRunId: uuidSchema.nullable(),
  downtimeSeconds: z.number().int().nullable(),
  // ---- Denormalized names (Phase 7): banner/timeline render without a
  // per-incident Check→App follow-up fetch. Optional/additive.
  appId: uuidSchema.optional(),
  appName: z.string().optional(),
  checkName: z.string().optional(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentListSchema = z.array(incidentSchema);

export const listIncidentsQuerySchema = z.object({
  open: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  appId: uuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;

/** GET /incidents — the global, cross-app incident tab. Keyset-paginated. */
export const incidentPageResponseSchema = z.object({
  incidents: incidentListSchema,
  nextCursor: z.string().nullable(),
});
export type IncidentPageResponse = z.infer<typeof incidentPageResponseSchema>;
