import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import {
  loginBodySchema,
  loginResponseSchema,
  refreshResponseSchema,
  logoutResponseSchema,
  setupStatusResponseSchema,
  setupBodySchema,
  userSchema,
} from '@vyzus/shared';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { hashToken } from '../lib/tokens.js';
import { toUser } from '../lib/mappers.js';
import { conflict, unauthorized } from '../lib/errors.js';

const REFRESH_COOKIE = 'refreshToken';
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(
  app: { config: { isProduction: boolean } },
  reply: FastifyReply,
  token: string,
  maxAge: number,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: app.config.isProduction,
    path: COOKIE_PATH,
    maxAge,
  });
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  async function userCount(): Promise<number> {
    const rows = await app.db.select({ count: sql<number>`count(*)::int` }).from(users);
    return rows[0]?.count ?? 0;
  }

  // GET /auth/setup-status — unauthenticated; the dashboard uses this to show
  // the first-boot setup screen instead of the login form.
  app.get('/setup-status', { schema: { response: { 200: setupStatusResponseSchema } } }, async () => ({
    needsSetup: (await userCount()) === 0,
  }));

  // POST /auth/setup — creates the first admin on a fresh install and logs
  // them straight in. Necessarily unauthenticated, so it is gated on the
  // users table being empty; once any user exists this is permanently 409 and
  // further accounts go through the admin-only POST /users. The count check
  // and the insert run in one transaction with the table locked, so two
  // simultaneous setup submissions can't both create an admin.
  app.post(
    '/setup',
    { schema: { body: setupBodySchema, response: { 201: loginResponseSchema } } },
    async (req, reply) => {
      const { email, password } = req.body;
      const passwordHash = await hashPassword(password);

      const user = await app.db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
        const rows = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
        if ((rows[0]?.count ?? 0) > 0) return null;
        const [created] = await tx.insert(users).values({ email, passwordHash, role: 'admin' }).returning();
        return created ?? null;
      });

      if (!user) throw conflict('Setup has already been completed', 'SETUP_ALREADY_DONE');
      req.log.info({ email }, 'first admin created via setup');

      const accessToken = await app.tokens.signAccessToken({
        sub: user.id,
        role: user.role,
        email: user.email,
      });
      const { token: refreshToken, hash } = await app.tokens.issueRefreshToken(user.id);
      await app.db.update(users).set({ refreshTokenHash: hash }).where(eq(users.id, user.id));
      setRefreshCookie(app, reply, refreshToken, app.tokens.refreshCookieMaxAgeSeconds);

      return reply.status(201).send({ accessToken, user: toUser(user) });
    },
  );

  // POST /auth/login
  app.post(
    '/login',
    { schema: { body: loginBodySchema, response: { 200: loginResponseSchema } } },
    async (req, reply) => {
      const { email, password } = req.body;
      const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
      // Verify even when the user is missing to keep timing uniform.
      const ok = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyPassword(
            '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            password,
          );
      if (!user || !ok) throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');

      const accessToken = await app.tokens.signAccessToken({
        sub: user.id,
        role: user.role,
        email: user.email,
      });
      const { token: refreshToken, hash } = await app.tokens.issueRefreshToken(user.id);
      await app.db.update(users).set({ refreshTokenHash: hash }).where(eq(users.id, user.id));
      setRefreshCookie(app, reply, refreshToken, app.tokens.refreshCookieMaxAgeSeconds);

      return reply.send({ accessToken, user: toUser(user) });
    },
  );

  // POST /auth/refresh — verifies + rotates the refresh token.
  app.post('/refresh', { schema: { response: { 200: refreshResponseSchema } } }, async (req, reply) => {
    const cookie = req.cookies[REFRESH_COOKIE];
    if (!cookie) throw unauthorized('Missing refresh token');

    let userId: string;
    try {
      const claims = await app.tokens.verifyRefreshToken(cookie);
      userId = claims.sub;
    } catch {
      throw unauthorized('Invalid refresh token');
    }

    const [user] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    // Reject any token that isn't the current stored one (rotated-out / logged
    // out). We don't null the family here so a replayed old token can't
    // invalidate the legitimate current session.
    if (!user || !user.refreshTokenHash || user.refreshTokenHash !== hashToken(cookie)) {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw unauthorized('Refresh token no longer valid');
    }

    const accessToken = await app.tokens.signAccessToken({
      sub: user.id,
      role: user.role,
      email: user.email,
    });
    const { token: newRefresh, hash } = await app.tokens.issueRefreshToken(user.id);
    await app.db.update(users).set({ refreshTokenHash: hash }).where(eq(users.id, user.id));
    setRefreshCookie(app, reply, newRefresh, app.tokens.refreshCookieMaxAgeSeconds);

    return reply.send({ accessToken });
  });

  // POST /auth/logout — invalidates the stored refresh token.
  app.post('/logout', { schema: { response: { 200: logoutResponseSchema } } }, async (req, reply) => {
    const cookie = req.cookies[REFRESH_COOKIE];
    if (cookie) {
      try {
        const { sub } = await app.tokens.verifyRefreshToken(cookie);
        await app.db.update(users).set({ refreshTokenHash: null }).where(eq(users.id, sub));
      } catch {
        // ignore — clearing the cookie is enough
      }
    }
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.send({ ok: true as const });
  });

  // GET /auth/me — current user.
  app.get('/me', { preHandler: app.authenticate, schema: { response: { 200: userSchema } } }, async (req) => {
    const [user] = await app.db.select().from(users).where(eq(users.id, req.authUser!.id)).limit(1);
    if (!user) throw unauthorized();
    return toUser(user);
  });
};
