// Authentication + role-guard decorators. `authenticate` verifies the Bearer
// access token and populates `request.authUser`; `requireRole` gates mutating
// routes. Both are registered as instance decorators in buildApp so every route
// can reference them via `app.authenticate` / `app.requireRole('admin')`.
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { UserRole } from '@vyzus/shared';
import type { TokenService } from '../lib/tokens.js';
import { eq } from 'drizzle-orm';
import { forbidden, unauthorized } from '../lib/errors.js';
import { apiTokens, users } from '../db/schema.js';
import { hashToken } from '../lib/tokens.js';
import { API_TOKEN_PREFIX } from '../routes/tokens.js';
import type { Database } from '../db/index.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  email: string;
}

export function createAuthenticate(tokens: TokenService, db: Database): preHandlerHookHandler {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();

    // Two credential kinds share the Bearer header. API tokens carry a
    // distinguishing prefix so there is no ambiguity and no need to try one
    // and fall back to the other (which would make a bad JWT cost a DB round
    // trip, and vice versa).
    if (token.startsWith(API_TOKEN_PREFIX)) {
      request.authUser = await authenticateApiToken(db, token);
      return;
    }

    try {
      const claims = await tokens.verifyAccessToken(token);
      request.authUser = { id: claims.sub, role: claims.role, email: claims.email };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
}

/**
 * An API token acts as its owning user, so authorization downstream is
 * identical to a logged-in session — same id, same role, same viewer scoping.
 */
async function authenticateApiToken(db: Database, token: string): Promise<AuthUser> {
  const [row] = await db
    .select({
      tokenId: apiTokens.id,
      expiresAt: apiTokens.expiresAt,
      id: users.id,
      role: users.role,
      email: users.email,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hashToken(token)))
    .limit(1);

  // Same message for unknown and expired: a caller holding a bad token learns
  // nothing about whether it ever existed.
  if (!row) throw unauthorized('Invalid or expired token');
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw unauthorized('Invalid or expired token');

  // Best-effort last-used stamp so an operator can spot tokens nobody uses.
  // Deliberately not awaited into the request path's critical section and
  // never allowed to fail a request that is otherwise authorized.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.tokenId))
    .catch(() => undefined);

  return { id: row.id, role: row.role, email: row.email };
}

/**
 * Role guard. Must run after `authenticate` (compose them in a route's
 * preHandler array). Admin implicitly satisfies any editor-only requirement.
 */
export function createRequireRole(...allowed: UserRole[]): preHandlerHookHandler {
  return async function requireRole(request: FastifyRequest): Promise<void> {
    const user = request.authUser;
    if (!user) throw unauthorized();
    if (user.role === 'admin') return; // admin can do everything
    if (!allowed.includes(user.role)) {
      throw forbidden(`Requires role: ${allowed.join(' or ')}`);
    }
  };
}
