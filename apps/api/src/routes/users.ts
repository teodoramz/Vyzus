import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createUserBodySchema,
  updateUserBodySchema,
  userSchema,
  userListSchema,
  userAppAccessSchema,
  idParamSchema,
} from '@vyzus/shared';
import { users, userAppAccess, applications } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { toUser } from '../lib/mappers.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

// All user management is admin-only.
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const adminOnly = [app.authenticate, app.requireRole('admin')];

  app.get('/', { preHandler: adminOnly, schema: { response: { 200: userListSchema } } }, async () => {
    const rows = await app.db.select().from(users).orderBy(users.createdAt);
    return rows.map(toUser);
  });

  app.post(
    '/',
    { preHandler: adminOnly, schema: { body: createUserBodySchema, response: { 201: userSchema } } },
    async (req, reply) => {
      const { email, password, role } = req.body;
      const existing = await app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) throw conflict('A user with that email already exists', 'EMAIL_TAKEN');
      const passwordHash = await hashPassword(password);
      const [row] = await app.db.insert(users).values({ email, passwordHash, role }).returning();
      return reply.status(201).send(toUser(row!));
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: adminOnly,
      schema: { params: idParamSchema, body: updateUserBodySchema, response: { 200: userSchema } },
    },
    async (req) => {
      const { id } = req.params;
      const update: Partial<{
        role: 'admin' | 'editor' | 'viewer';
        passwordHash: string;
        refreshTokenHash: string | null;
      }> = {};
      if (req.body.role !== undefined) update.role = req.body.role;
      if (req.body.password !== undefined) {
        update.passwordHash = await hashPassword(req.body.password);
        // A reset is how a compromised account is taken back, so it must end
        // the sessions that password protected. The refresh token is an
        // independent credential: left alone it keeps minting access tokens for
        // the rest of its 7-day life.
        update.refreshTokenHash = null;
      }
      const [row] = await app.db.update(users).set(update).where(eq(users.id, id)).returning();
      if (!row) throw notFound('User not found');
      return toUser(row);
    },
  );

  app.delete('/:id', { preHandler: adminOnly, schema: { params: idParamSchema } }, async (req, reply) => {
    const { id } = req.params;
    if (id === req.authUser!.id) throw badRequest('You cannot delete your own account', 'SELF_DELETE');
    const [row] = await app.db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw notFound('User not found');
    return reply.status(204).send();
  });

  // GET/PUT /users/:id/apps — which applications a viewer can see/act on.
  // Meaningless for admin/editor (unrestricted already) but not rejected —
  // simplest for the admin UI, which doesn't need to special-case role here.
  app.get(
    '/:id/apps',
    { preHandler: adminOnly, schema: { params: idParamSchema, response: { 200: userAppAccessSchema } } },
    async (req) => {
      const [user] = await app.db.select({ id: users.id }).from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!user) throw notFound('User not found');
      const rows = await app.db
        .select({ appId: userAppAccess.appId })
        .from(userAppAccess)
        .where(eq(userAppAccess.userId, req.params.id));
      return { appIds: rows.map((r) => r.appId) };
    },
  );

  app.put(
    '/:id/apps',
    {
      preHandler: adminOnly,
      schema: { params: idParamSchema, body: userAppAccessSchema, response: { 200: userAppAccessSchema } },
    },
    async (req) => {
      const { id } = req.params;
      const [user] = await app.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw notFound('User not found');

      const { appIds } = req.body;
      if (appIds.length > 0) {
        const rows = await app.db.select({ id: applications.id }).from(applications);
        const validIds = new Set(rows.map((r) => r.id));
        const invalid = appIds.filter((appId) => !validIds.has(appId));
        if (invalid.length > 0) throw badRequest(`Unknown application id(s): ${invalid.join(', ')}`, 'UNKNOWN_APP');
      }

      await app.db.transaction(async (tx) => {
        await tx.delete(userAppAccess).where(eq(userAppAccess.userId, id));
        if (appIds.length > 0) {
          await tx.insert(userAppAccess).values(appIds.map((appId) => ({ userId: id, appId })));
        }
      });
      return { appIds };
    },
  );
};
