// API entrypoint. Boot order (05-infrastructure): validate env → migrate →
// seed first admin → build app (with the real BullMQ scheduler) → reconcile
// schedules from the DB → start the alerter → listen. Migrations run before
// the server accepts traffic.
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { BullMqSchedulerService } from './services/scheduler.js';
import { startAlerter } from './services/alerter.js';
import { startRetentionWorker } from './services/retention.js';
import { createAlertsQueue, runHeartbeat } from './services/heartbeat.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: 'info' });

  await runMigrations(config.DATABASE_URL);

  const dbHandle = createDb(config.DATABASE_URL);

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // Real BullMQ scheduler (Phase 3), injected into the app.
  const scheduler = new BullMqSchedulerService(redis, dbHandle.db, log);

  const app = await buildApp({ config, dbHandle, redis, scheduler });

  // DB is the source of truth; rebuild Redis repeatables on every boot.
  await scheduler.reconcileSchedules();

  // Alert dispatcher (Phase 5) consumes the `alerts` queue in-process.
  const alerter = startAlerter({
    connection: redis,
    db: dbHandle.db,
    publicUrl: config.PUBLIC_URL,
    log,
  });

  // Maintenance (Phase 7 + dead-man's switch): the daily retention and
  // per-minute heartbeat repeatables are registered by reconcileSchedules
  // above; this worker consumes both.
  //
  // The heartbeat lives in the API on purpose. Hosting it in the worker would
  // mean the switch dies with the process it exists to watch.
  const heartbeatAlerts = createAlertsQueue(redis);
  const retention = startRetentionWorker({
    connection: redis,
    db: dbHandle.db,
    artifactsDir: config.ARTIFACTS_DIR,
    log,
    onHeartbeat: async () => {
      await runHeartbeat(dbHandle.db, heartbeatAlerts, log);
    },
  });

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await alerter.close();
    await retention.close();
    await heartbeatAlerts.close();
    await scheduler.close();
    await app.close();
    await dbHandle.sql.end({ timeout: 5 });
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`API listening on ${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
