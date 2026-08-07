import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { settingsSchema, updateSettingsBodySchema, SETTINGS_KEYS } from '@vyzus/shared';
import { settings } from '../db/schema.js';
import { toSettings } from '../lib/mappers.js';

const KEY_FOR = {
  runsDays: SETTINGS_KEYS.runsDays,
  screenshotsDays: SETTINGS_KEYS.screenshotsDays,
  tracesDays: SETTINGS_KEYS.tracesDays,
  heartbeatStallMinutes: SETTINGS_KEYS.heartbeatStallMinutes,
} as const;

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  async function readSettings(): Promise<ReturnType<typeof toSettings>> {
    const rows = await app.db.select().from(settings);
    return toSettings(rows.map((r) => ({ key: r.key, value: r.value })));
  }

  // GET /settings — any authenticated user may view retention config.
  app.get('/', { preHandler: app.authenticate, schema: { response: { 200: settingsSchema } } }, async () =>
    readSettings(),
  );

  // PATCH /settings — admin-only retention update (upsert key/value rows).
  app.patch(
    '/',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: { body: updateSettingsBodySchema, response: { 200: settingsSchema } },
    },
    async (req) => {
      const entries = Object.entries(req.body) as [keyof typeof KEY_FOR, number][];
      await app.db.transaction(async (tx) => {
        for (const [field, value] of entries) {
          if (value === undefined) continue;
          await tx
            .insert(settings)
            .values({ key: KEY_FOR[field], value })
            .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
        }
      });
      return readSettings();
    },
  );
};
