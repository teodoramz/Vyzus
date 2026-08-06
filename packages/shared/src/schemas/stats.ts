import { z } from 'zod';

export const statsSchema = z.object({
  apps: z.object({
    total: z.number().int(),
    up: z.number().int(),
    degraded: z.number().int(),
    down: z.number().int(),
    paused: z.number().int(),
  }),
  openIncidents: z.number().int(),
  queueDepth: z.number().int(),
  runsLast24h: z.number().int(),
});
export type Stats = z.infer<typeof statsSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.boolean(),
  redis: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
