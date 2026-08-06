import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { runSchema, runListQuerySchema, runListResponseSchema, idParamSchema } from '@vyzus/shared';
import { runs } from '../db/schema.js';
import { toRun } from '../lib/mappers.js';
import { notFound } from '../lib/errors.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';
import { assertCheckAccess, assertRunAccess } from '../lib/access.js';

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /checks/:id/runs — keyset pagination on (started_at, id) desc.
  app.get(
    '/checks/:id/runs',
    {
      preHandler: app.authenticate,
      schema: { params: idParamSchema, querystring: runListQuerySchema, response: { 200: runListResponseSchema } },
    },
    async (req) => {
      const { id } = req.params;
      await assertCheckAccess(app.db, req.authUser!, id);
      const { cursor, limit, status, hasScreenshot } = req.query;
      const conditions = [eq(runs.checkId, id)];
      if (status) conditions.push(eq(runs.status, status));
      if (hasScreenshot) conditions.push(isNotNull(runs.screenshotPath));
      if (cursor) {
        const c = decodeCursor(cursor);
        const cDate = new Date(c.s);
        conditions.push(or(lt(runs.startedAt, cDate), and(eq(runs.startedAt, cDate), lt(runs.id, c.id)))!);
      }
      const rows = await app.db
        .select()
        .from(runs)
        .where(and(...conditions))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? encodeCursor({ s: last.startedAt.toISOString(), id: last.id }) : null;
      return { runs: page.map(toRun), nextCursor };
    },
  );

  // GET /runs/:id — full detail.
  app.get(
    '/runs/:id',
    { preHandler: app.authenticate, schema: { params: idParamSchema, response: { 200: runSchema } } },
    async (req) => {
      const [row] = await app.db.select().from(runs).where(eq(runs.id, req.params.id)).limit(1);
      if (!row) throw notFound('Run not found');
      await assertRunAccess(app.db, req.authUser!, row.id);
      return toRun(row);
    },
  );

  // Artifact streaming — auth required, paths come from the DB (never from the
  // client), and are resolved inside ARTIFACTS_DIR only.
  const streamArtifact = (relPath: string, contentType: string, downloadName?: string) => {
    const root = path.resolve(app.config.ARTIFACTS_DIR);
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(root + path.sep)) throw notFound('Artifact not found');
    if (!existsSync(abs)) throw notFound('Artifact file missing');
    const stream = createReadStream(abs);
    return { stream, contentType, downloadName };
  };

  app.get(
    '/runs/:id/artifacts/screenshot',
    { preHandler: app.authenticate, schema: { params: idParamSchema } },
    async (req, reply) => {
      const [row] = await app.db.select().from(runs).where(eq(runs.id, req.params.id)).limit(1);
      if (!row || !row.screenshotPath) throw notFound('No screenshot for this run');
      await assertRunAccess(app.db, req.authUser!, row.id);
      const { stream, contentType } = streamArtifact(row.screenshotPath, 'image/png');
      return reply.type(contentType).send(stream);
    },
  );

  app.get(
    '/runs/:id/artifacts/trace',
    { preHandler: app.authenticate, schema: { params: idParamSchema } },
    async (req, reply) => {
      const [row] = await app.db.select().from(runs).where(eq(runs.id, req.params.id)).limit(1);
      if (!row || !row.tracePath) throw notFound('No trace for this run');
      await assertRunAccess(app.db, req.authUser!, row.id);
      const { stream, contentType } = streamArtifact(row.tracePath, 'application/zip');
      return reply
        .type(contentType)
        .header('content-disposition', `attachment; filename="trace-${row.id}.zip"`)
        .send(stream);
    },
  );
};
