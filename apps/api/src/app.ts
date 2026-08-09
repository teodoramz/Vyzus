// buildApp — assembles the Fastify instance: Zod validation/serialization,
// cookie support, shared decorators (db, redis, tokens, scheduler, auth guards),
// the uniform error handler, and all route groups. Dependencies are injected so
// integration tests can supply their own db/redis/scheduler.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config.js';
import type { DbHandle } from './db/index.js';
import { TokenService } from './lib/tokens.js';
import { errorHandler } from './lib/errors.js';
import { createAuthenticate, createRequireRole } from './plugins/auth.js';
import { NoopSchedulerService, type SchedulerService } from './services/scheduler.js';
import { registerWs } from './plugins/ws.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { appRoutes } from './routes/apps.js';
import { checkRoutes } from './routes/checks.js';
import { channelRoutes } from './routes/channels.js';
import { settingsRoutes } from './routes/settings.js';
import { tokenRoutes } from './routes/tokens.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { pushRoutes } from './routes/push.js';
import { statusRoutes } from './routes/status.js';
import { statsRoutes } from './routes/stats.js';
import { runRoutes } from './routes/runs.js';
import { incidentRoutes } from './routes/incidents.js';

export interface BuildAppDeps {
  config: AppConfig;
  dbHandle: DbHandle;
  redis: Redis;
  scheduler?: SchedulerService;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { config, dbHandle, redis } = deps;

  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MB (journey specs are capped at 64 KB)
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  await app.register(cookie);

  const tokens = new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL, config.REFRESH_TOKEN_TTL_DAYS);

  app.decorate('config', config);
  app.decorate('dbHandle', dbHandle);
  app.decorate('db', dbHandle.db);
  app.decorate('redis', redis);
  app.decorate('tokens', tokens);
  app.decorate('encryptionKey', config.ENCRYPTION_KEY);
  app.decorate('scheduler', deps.scheduler ?? new NoopSchedulerService(app.log));
  app.decorate('authenticate', createAuthenticate(tokens, dbHandle.db));
  app.decorate('requireRole', (...roles) => createRequireRole(...roles));

  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(appRoutes, { prefix: '/api/v1/apps' });
  await app.register(checkRoutes, { prefix: '/api/v1' });
  await app.register(channelRoutes, { prefix: '/api/v1/channels' });
  await app.register(settingsRoutes, { prefix: '/api/v1/settings' });
  await app.register(tokenRoutes, { prefix: '/api/v1/tokens' });
  await app.register(maintenanceRoutes, { prefix: '/api/v1/maintenance' });
  // Unauthenticated by design — see routes/push.ts.
  await app.register(pushRoutes, { prefix: '/api/v1/push' });
  // Unauthenticated, opt-in per application — see routes/status.ts.
  await app.register(statusRoutes, { prefix: '/api/v1/status' });
  await app.register(statsRoutes, { prefix: '/api/v1' });
  await app.register(runRoutes, { prefix: '/api/v1' });
  await app.register(incidentRoutes, { prefix: '/api/v1' });

  // WebSocket push at /ws (nginx proxies it outside /api — see infra/nginx.conf).
  await registerWs(app);

  return app;
}
