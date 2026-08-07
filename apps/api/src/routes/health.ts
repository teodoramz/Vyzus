import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { healthResponseSchema } from '@vyzus/shared';

// GET /health — unauthenticated liveness: pings Postgres and Redis.
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
    async (_req, reply) => {
      let db = false;
      let redis = false;
      try {
        await app.db.execute(sql`select 1`);
        db = true;
      } catch {
        // leave `db` false — the initializer is the failure value
      }
      try {
        const pong = await app.redis.ping();
        redis = pong === 'PONG';
      } catch {
        // leave `redis` false
      }
      const ok = db && redis;
      return reply.status(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'degraded',
        db,
        redis,
      });
    },
  );
};
