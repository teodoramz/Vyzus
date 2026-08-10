import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createChannelBodySchema,
  updateChannelBodySchema,
  channelSchema,
  channelListSchema,
  testChannelResponseSchema,
  alertDeliveryListSchema,
  idParamSchema,
  splitChannelSecrets,
  type ChannelSecrets,
} from '@vyzus/shared';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { alertChannels, appAlertChannels, alertDeliveries, users } from '../db/schema.js';
import type { AlertChannelRow } from '../db/schema.js';
import { toChannel } from '../lib/mappers.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { deliverToChannel, sampleAlertPayload } from '../services/alerter.js';
import { accessibleAppIds, assertChannelOwnership } from '../lib/access.js';

// Channel management remains admin-only for global channels (editor is
// excluded, exactly as before this role existed — editors manage apps/
// checks, never alert routing). The only change: a viewer may additionally
// create/manage channels of their own — self-service alert routing for the
// apps they're assigned to — but never sees or touches another user's
// channels, and can't target apps outside their assignment or use "all
// apps" (that would reach apps they can't see). See lib/access.ts
// assertChannelOwnership. `app.requireRole('viewer')` reads oddly here but
// is exactly "admin (bypasses) or viewer" — editor is not in the allow-list.
export const channelRoutes: FastifyPluginAsyncZod = async (app) => {
  const authed = [app.authenticate, app.requireRole('viewer')];

  async function appIdsFor(channelId: string): Promise<string[]> {
    const rows = await app.db
      .select({ appId: appAlertChannels.appId })
      .from(appAlertChannels)
      .where(eq(appAlertChannels.channelId, channelId));
    return rows.map((r) => r.appId);
  }

  async function emailFor(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const [row] = await app.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? null;
  }

  async function present(row: AlertChannelRow): Promise<ReturnType<typeof toChannel>> {
    const [appIds, createdByEmail] = await Promise.all([
      row.allApps ? Promise.resolve([]) : appIdsFor(row.id),
      emailFor(row.createdBy),
    ]);
    return toChannel(row, appIds, createdByEmail);
  }

  /** Viewer create/update guardrail: no all-apps, every appId must be theirs. */
  async function assertViewerChannelScope(
    userId: string,
    allowedIds: string[],
    body: { allApps?: boolean | undefined; appIds?: string[] | undefined },
  ): Promise<void> {
    if (body.allApps) throw forbidden('Viewers cannot create an all-apps channel');
    const invalid = (body.appIds ?? []).filter((id) => !allowedIds.includes(id));
    if (invalid.length > 0)
      throw badRequest('Channel can only target applications you have access to', 'APP_NOT_ASSIGNED');
    void userId;
  }

  app.get('/', { preHandler: authed, schema: { response: { 200: channelListSchema } } }, async (req) => {
    const user = req.authUser!;
    let rows = await app.db.select().from(alertChannels).orderBy(alertChannels.name);
    if (user.role === 'viewer') rows = rows.filter((r) => r.ownerId === user.id);
    return Promise.all(rows.map(present));
  });

  app.post(
    '/',
    { preHandler: authed, schema: { body: createChannelBodySchema, response: { 201: channelSchema } } },
    async (req, reply) => {
      const user = req.authUser!;
      const { name, type, config, enabled, allApps, appIds } = req.body;
      let ownerId: string | null = null;
      if (user.role === 'viewer') {
        const allowedIds = (await accessibleAppIds(app.db, user)) ?? [];
        await assertViewerChannelScope(user.id, allowedIds, { allApps, appIds });
        ownerId = user.id;
      }
      // Credentials never reach the jsonb column — see shared/channel-secrets.ts.
      const split = splitChannelSecrets(config);
      const secretsEnc = split.secrets ? encryptJson(split.secrets, app.encryptionKey) : null;
      const row = await app.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(alertChannels)
          .values({
            name,
            type,
            config: split.config,
            secretsEnc,
            enabled,
            allApps,
            ownerId,
            createdBy: user.id,
          })
          .returning();
        if (!allApps && appIds.length > 0) {
          await tx.insert(appAlertChannels).values(appIds.map((appId) => ({ appId, channelId: inserted!.id })));
        }
        return inserted!;
      });
      return reply.status(201).send(await present(row));
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: authed,
      schema: { params: idParamSchema, body: updateChannelBodySchema, response: { 200: channelSchema } },
    },
    async (req) => {
      const user = req.authUser!;
      const { id } = req.params;
      const [existing] = await app.db.select().from(alertChannels).where(eq(alertChannels.id, id)).limit(1);
      if (!existing) throw notFound('Channel not found');
      assertChannelOwnership(user, existing);

      const b = req.body;
      if (user.role === 'viewer') {
        const allowedIds = (await accessibleAppIds(app.db, user)) ?? [];
        await assertViewerChannelScope(user.id, allowedIds, { allApps: b.allApps, appIds: b.appIds });
      }

      const patch: Partial<typeof alertChannels.$inferInsert> = {};
      if (b.name !== undefined) patch.name = b.name;
      if (b.type !== undefined) patch.type = b.type;
      if (b.config !== undefined) {
        const split = splitChannelSecrets(b.config);
        patch.config = split.config;
        // A submitted config with no credential means "leave the stored one
        // alone" — the dashboard sends blank fields to keep the existing
        // secret, exactly as it does for application credentials.
        if (split.secrets) patch.secretsEnc = encryptJson(split.secrets, app.encryptionKey);
      }
      // A webhook signing secret means nothing to an SMTP transport. Changing
      // the type makes the stored credential meaningless, so drop it rather
      // than leave a blob nobody can account for — unless this same request
      // supplied a replacement. `type` may arrive without `config`, so this
      // cannot live in the branch above.
      if (b.type !== undefined && b.type !== existing.type && patch.secretsEnc === undefined) {
        patch.secretsEnc = null;
      }
      if (b.enabled !== undefined) patch.enabled = b.enabled;
      if (b.allApps !== undefined) patch.allApps = b.allApps;

      const row = await app.db.transaction(async (tx) => {
        const [updated] = Object.keys(patch).length
          ? await tx.update(alertChannels).set(patch).where(eq(alertChannels.id, id)).returning()
          : [existing];
        // Reconcile the join table when allApps or an explicit appIds list is given.
        const effectiveAllApps = b.allApps ?? updated!.allApps;
        if (b.appIds !== undefined || b.allApps !== undefined) {
          await tx.delete(appAlertChannels).where(eq(appAlertChannels.channelId, id));
          if (!effectiveAllApps && b.appIds && b.appIds.length > 0) {
            await tx.insert(appAlertChannels).values(b.appIds.map((appId) => ({ appId, channelId: id })));
          }
        }
        return updated!;
      });
      return present(row);
    },
  );

  app.delete('/:id', { preHandler: authed, schema: { params: idParamSchema } }, async (req, reply) => {
    const [existing] = await app.db.select().from(alertChannels).where(eq(alertChannels.id, req.params.id)).limit(1);
    if (!existing) throw notFound('Channel not found');
    assertChannelOwnership(req.authUser!, existing);
    await app.db.delete(alertChannels).where(eq(alertChannels.id, req.params.id));
    return reply.status(204).send();
  });

  // POST /channels/:id/test — sends a fully rendered sample alert (same Block
  // Kit / embed / signed JSON path the alerter uses), single attempt.
  app.post(
    '/:id/test',
    { preHandler: authed, schema: { params: idParamSchema, response: { 200: testChannelResponseSchema } } },
    async (req) => {
      const [row] = await app.db.select().from(alertChannels).where(eq(alertChannels.id, req.params.id)).limit(1);
      if (!row) throw notFound('Channel not found');
      assertChannelOwnership(req.authUser!, row);
      const secrets = row.secretsEnc ? decryptJson<ChannelSecrets>(row.secretsEnc, app.encryptionKey) : null;
      const outcome = await deliverToChannel(
        row,
        secrets,
        sampleAlertPayload(app.config.PUBLIC_URL),
        app.config.PUBLIC_URL,
        { maxAttempts: 1 },
      );
      return { ok: outcome.ok, responseCode: outcome.responseCode };
    },
  );

  // GET /channels/:id/deliveries
  app.get(
    '/:id/deliveries',
    { preHandler: authed, schema: { params: idParamSchema, response: { 200: alertDeliveryListSchema } } },
    async (req) => {
      const [row] = await app.db.select().from(alertChannels).where(eq(alertChannels.id, req.params.id)).limit(1);
      if (!row) throw notFound('Channel not found');
      assertChannelOwnership(req.authUser!, row);
      const rows = await app.db
        .select()
        .from(alertDeliveries)
        .where(eq(alertDeliveries.channelId, req.params.id))
        .orderBy(alertDeliveries.createdAt);
      return rows.map((d) => ({
        id: d.id,
        incidentId: d.incidentId,
        channelId: d.channelId,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        responseCode: d.responseCode,
        createdAt: d.createdAt.toISOString(),
      }));
    },
  );
};
