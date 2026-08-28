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

/** The two artifacts differ only in these four things. */
interface ArtifactKind {
  column: 'screenshotPath' | 'tracePath';
  contentType: string;
  missing: string;
  attachment: ((runId: string) => string) | null;
}

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
  function openArtifact(relPath: string) {
    const root = path.resolve(app.config.ARTIFACTS_DIR);
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(root + path.sep)) throw notFound('Artifact not found');
    if (!existsSync(abs)) throw notFound('Artifact file missing');
    return createReadStream(abs);
  }

  const ARTIFACTS = {
    screenshot: {
      column: 'screenshotPath',
      contentType: 'image/png',
      missing: 'No screenshot for this run',
      attachment: null,
    },
    trace: {
      column: 'tracePath',
      contentType: 'application/zip',
      missing: 'No trace for this run',
      // Browsers would otherwise try to render the zip inline.
      attachment: (runId: string) => `trace-${runId}.zip`,
    },
  } as const satisfies Record<string, ArtifactKind>;

  for (const [name, kind] of Object.entries(ARTIFACTS)) {
    app.get(
      `/runs/:id/artifacts/${name}`,
      { preHandler: app.authenticate, schema: { params: idParamSchema } },
      async (req, reply) => {
        const [row] = await app.db.select().from(runs).where(eq(runs.id, req.params.id)).limit(1);
        const relPath = row?.[kind.column];
        if (!row || !relPath) throw notFound(kind.missing);
        await assertRunAccess(app.db, req.authUser!, row.id);

        reply.type(kind.contentType);
        if (kind.attachment) {
          reply.header('content-disposition', `attachment; filename="${kind.attachment(row.id)}"`);
        }
        return reply.send(openArtifact(relPath));
      },
    );
  }
};
