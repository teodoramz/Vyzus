// API tokens (backlog task 9). scripts/sync-targets.mjs authenticated with a
// human's email and password supplied through the environment; a scoped,
// revocable token is the right primitive for CI provisioning.
//
// A token acts as its owning user — same id, role and per-viewer application
// scoping — so every rule in lib/access.ts applies unchanged rather than
// through a second permission model that could drift from the first.
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  apiTokenListSchema,
  createApiTokenBodySchema,
  createdApiTokenSchema,
  idParamSchema,
  type ApiToken,
} from '@vyzus/shared';
import { apiTokens } from '../db/schema.js';
import { hashToken } from '../lib/tokens.js';
import { notFound } from '../lib/errors.js';

/** Recognisable prefix so a leaked token is greppable and obviously a credential. */
export const API_TOKEN_PREFIX = 'vyz_';

/** 32 bytes of CSPRNG output — 256 bits, far past any brute-force reach. */
export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

function toApiToken(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

export const tokenRoutes: FastifyPluginAsyncZod = async (app) => {
  // Every route here is scoped to the caller's own tokens. Deliberately not
  // admin-listable: an admin gaining a view of other people's credentials
  // buys nothing (the hashes are useless) and widens the blast radius.

  // GET /tokens — the caller's own tokens. Never includes the secret.
  app.get('/', { preHandler: app.authenticate, schema: { response: { 200: apiTokenListSchema } } }, async (req) => {
    const rows = await app.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, req.authUser!.id))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(toApiToken);
  });

  // POST /tokens — returns the secret exactly once; only its hash is stored.
  app.post(
    '/',
    {
      preHandler: app.authenticate,
      schema: { body: createApiTokenBodySchema, response: { 201: createdApiTokenSchema } },
    },
    async (req, reply) => {
      const { name, expiresInDays } = req.body;
      const token = generateApiToken();
      const expiresAt = expiresInDays === undefined ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

      const [row] = await app.db
        .insert(apiTokens)
        .values({ userId: req.authUser!.id, name, tokenHash: hashToken(token), expiresAt })
        .returning();

      req.log.info({ tokenId: row!.id, userId: req.authUser!.id, name }, 'api token created');
      return reply.status(201).send({ ...toApiToken(row!), token });
    },
  );

  // DELETE /tokens/:id — revocation is immediate; authentication reads the row.
  app.delete('/:id', { preHandler: app.authenticate, schema: { params: idParamSchema } }, async (req, reply) => {
    const [deleted] = await app.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, req.authUser!.id)))
      .returning({ id: apiTokens.id });
    if (!deleted) throw notFound('Token not found');
    req.log.info({ tokenId: deleted.id }, 'api token revoked');
    return reply.status(204).send();
  });
};
