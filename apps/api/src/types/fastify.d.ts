// Module augmentation for the decorators buildApp attaches to the Fastify
// instance and request.
import type { preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import type { UserRole } from '@vyzus/shared';
import type { AppConfig } from '../config.js';
import type { Database, DbHandle } from '../db/index.js';
import type { TokenService } from '../lib/tokens.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { AuthUser } from '../plugins/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    dbHandle: DbHandle;
    db: Database;
    redis: Redis;
    tokens: TokenService;
    scheduler: SchedulerService;
    encryptionKey: string;
    /** Verifies the Bearer access token; sets request.authUser. */
    authenticate: preHandlerHookHandler;
    /** Builds a role-guard preHandler for the given roles. */
    requireRole: (...roles: UserRole[]) => preHandlerHookHandler;
  }

  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
