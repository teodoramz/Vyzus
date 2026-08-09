import { z } from 'zod';
import { appStatusSchema } from './apps.js';
import { isoTimestamp, uuidSchema } from './common.js';

/**
 * Public status page payload.
 *
 * Deliberately a *separate* schema from the authenticated app views rather than
 * a subset of them: the risk here is leaking something by accident, and a
 * schema that lists exactly what is public makes an accidental addition an
 * explicit edit rather than a side effect of adding a field elsewhere.
 *
 * Not included, on purpose: landing URLs (they are often internal), check names
 * and types (they describe the internal topology), run error messages (they
 * routinely carry internal hostnames, stack traces and query strings), and any
 * application not explicitly marked public.
 */
export const publicAppStatusSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: appStatusSchema,
  /** 0..1 fractions, or null when there are no runs in the window. */
  availability24h: z.number().nullable(),
  availability30d: z.number().nullable(),
});
export type PublicAppStatus = z.infer<typeof publicAppStatusSchema>;

/** An incident, stripped to timing — no error text, no check identity. */
export const publicIncidentSchema = z.object({
  id: uuidSchema,
  appName: z.string(),
  openedAt: isoTimestamp,
  resolvedAt: isoTimestamp.nullable(),
  downtimeSeconds: z.number().int().nullable(),
});
export type PublicIncident = z.infer<typeof publicIncidentSchema>;

export const statusPageSchema = z.object({
  title: z.string(),
  /** Worst status across the listed applications, for the headline banner. */
  overall: appStatusSchema,
  applications: z.array(publicAppStatusSchema),
  recentIncidents: z.array(publicIncidentSchema),
  generatedAt: isoTimestamp,
});
export type StatusPage = z.infer<typeof statusPageSchema>;
