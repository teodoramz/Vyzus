// Heartbeat receipt endpoint.
//
// Unauthenticated by design: a cron job reports in with one `curl` and no
// credential plumbing. The path token is the credential — 32 bytes of CSPRNG,
// scoped to one check, revocable by regenerating it.
//
// Only records that a ping arrived. Whether the check is healthy is decided in
// the worker on its normal schedule, so incidents, alerts and availability all
// work with no special case.
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checks } from '../db/schema.js';
import { notFound, tooManyRequests } from '../lib/errors.js';
import { hitFixedWindow } from '../lib/fixed-window.js';

const paramsSchema = z.object({ token: z.string().min(16).max(128) });
const responseSchema = z.object({ ok: z.literal(true) });

/**
 * Unauthenticated and it writes, so every attempt costs an UPDATE. Counted per
 * client IP, since an invalid token has no identity to count against. Well
 * above real use: heartbeats arrive on intervals measured in minutes.
 */
const RATE_LIMIT = 120;
const RATE_WINDOW_SECONDS = 60;

export const pushRoutes: FastifyPluginAsyncZod = async (app) => {
  async function recordPing(token: string): Promise<void> {
    // Matched in SQL against the jsonb config, so this is an indexed lookup
    // rather than a scan of every check.
    const updated = await app.db
      .update(checks)
      .set({ lastPingAt: new Date() })
      .where(sql`${checks.type} = 'push' AND ${checks.config}->>'token' = ${token}`)
      .returning({ id: checks.id });

    // Same 404 for unknown and disabled: a bad token learns nothing.
    if (updated.length === 0) throw notFound('Unknown heartbeat token');
  }

  // GET as well as POST: `curl` defaults to GET, and a ping that needs
  // `-X POST` is a ping people forget to send.
  for (const method of ['GET', 'POST'] as const) {
    app.route({
      method,
      url: '/:token',
      schema: { params: paramsSchema, response: { 200: responseSchema } },
      handler: async (req, reply) => {
        const limit = await hitFixedWindow(app.redis, `vyzus:push-rl:${req.ip}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
        if (!limit.allowed) {
          reply.header('Retry-After', String(limit.retryAfterSeconds));
          throw tooManyRequests('Too many heartbeat requests', 'RATE_LIMITED');
        }
        await recordPing((req.params as { token: string }).token);
        return { ok: true as const };
      },
    });
  }
};
