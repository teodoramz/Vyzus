// Worker entrypoint: a BullMQ Worker on the `checks` queue with
// WORKER_CONCURRENCY parallel jobs, one shared Chromium instance, a fresh
// browser context per run (02-architecture §4), and graceful shutdown.
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { QUEUE_NAMES } from '@vyzus/shared';
import { loadWorkerConfig } from './config.js';
import { createWorkerDb } from './db.js';
import { ArtifactStore } from './artifacts.js';
import { createProcessor } from './processor.js';
import { closeBrowser } from './browser.js';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = pino({ level: 'info' });

  const { db, sql } = createWorkerDb(config.DATABASE_URL);
  // One connection for BullMQ command traffic + PUBLISH (BullMQ duplicates
  // internally for its blocking consumer connection).
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const store = new ArtifactStore(config.ARTIFACTS_DIR);

  const processor = createProcessor({ db, redis, config, log, store });

  const worker = new Worker(QUEUE_NAMES.checks, (job) => processor.process(job), {
    connection: redis,
    concurrency: config.WORKER_CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, name: job?.name, err: err.message }, 'job failed');
  });
  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
  });

  log.info(
    { queue: QUEUE_NAMES.checks, concurrency: config.WORKER_CONCURRENCY, workerId: config.workerId },
    'worker started',
  );

  let shuttingDown = false;
  const close = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    await worker.close();
    await processor.close();
    await closeBrowser();
    await sql.end({ timeout: 5 });
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal worker boot error:', err);
  process.exit(1);
});
