// Heartbeat receipt endpoint (backlog task 13).
//
// Necessarily unauthenticated: the entire point is that a cron job or backup
// script can report in with one `curl` and no credential plumbing. The token in
// the path is the credential — 32 bytes of CSPRNG output, scoped to exactly one
// check, and revocable by regenerating it.
//
// This endpoint only records that a ping arrived. Deciding whether the check is
// healthy happens in the worker on the check's normal schedule, which is what
// keeps incidents, alerts and availability working with no special case.
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checks } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

const paramsSchema = z.object({ token: z.string().min(16).max(128) });
const responseSchema = z.object({ ok: z.literal(true) });

export const pushRoutes: FastifyPluginAsyncZod = async (app) => {
  async function recordPing(token: string): Promise<void> {
    // Matched in SQL against the token inside the jsonb config, so a scan of
    // every check is not needed and the token never has to be decrypted or
    // compared in application code.
    const updated = await app.db
      .update(checks)
      .set({ lastPingAt: new Date() })
      .where(sql`${checks.type} = 'push' AND ${checks.config}->>'token' = ${token}`)
      .returning({ id: checks.id });

    // Same 404 for an unknown token and a disabled check: a caller holding a
    // bad token learns nothing about whether it ever existed.
    if (updated.length === 0) throw notFound('Unknown heartbeat token');
  }

  // GET as well as POST: `curl` defaults to GET, and a monitoring ping that
  // requires remembering `-X POST` is a ping people forget to send.
  for (const method of ['GET', 'POST'] as const) {
    app.route({
      method,
      url: '/:token',
      schema: { params: paramsSchema, response: { 200: responseSchema } },
      handler: async (req) => {
        await recordPing((req.params as { token: string }).token);
        return { ok: true as const };
      },
    });
  }
};
