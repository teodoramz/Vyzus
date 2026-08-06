import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { statsSchema } from '@vyzus/shared';
import { computeStats } from '../lib/stats.js';
import { accessibleAppIds } from '../lib/access.js';

// GET /stats — header bar aggregates (04-api-spec). Scoped to a viewer's
// assigned apps — otherwise the header would show platform-wide up/down/
// incident counts to someone restricted to one app, which both confuses
// them and reveals that other apps exist.
export const statsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/stats', { preHandler: app.authenticate, schema: { response: { 200: statsSchema } } }, async (req) => {
    const queueDepth = await app.scheduler.getQueueDepth().catch(() => 0);
    const allowedAppIds = await accessibleAppIds(app.db, req.authUser!);
    return computeStats(app.db, queueDepth, allowedAppIds);
  });
};
