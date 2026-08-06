// Authentication + role-guard decorators. `authenticate` verifies the Bearer
// access token and populates `request.authUser`; `requireRole` gates mutating
// routes. Both are registered as instance decorators in buildApp so every route
// can reference them via `app.authenticate` / `app.requireRole('admin')`.
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { UserRole } from '@vyzus/shared';
import type { TokenService } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  email: string;
}

export function createAuthenticate(tokens: TokenService): preHandlerHookHandler {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const claims = await tokens.verifyAccessToken(token);
      request.authUser = { id: claims.sub, role: claims.role, email: claims.email };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
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
