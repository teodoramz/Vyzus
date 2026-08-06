// Full-stack smoke (Phase 7): the real HTTP API + a real BullMQ scheduler + a
// real worker (Playwright) wired together. Exercises the production path
//   login → enroll app → run now → run persisted
// end to end. (This is the API-level substitution the plan permits when driving
// the built dashboard in a browser is too heavy for the CI env — it still uses
// the real API routes, the real queue, and the real Playwright worker.)
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { pino } from 'pino';
import { QUEUE_NAMES } from '@vyzus/shared';
import { createProcessor, ArtifactStore, closeBrowser, createWorkerDb, type WorkerConfig } from '@vyzus/worker/testkit';
import { buildApp } from '../app.js';
import { BullMqSchedulerService } from '../services/scheduler.js';
import { makeTestConfig, resetDb, login, authHeader, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers.js';
import { createDb, type DbHandle } from '../db/index.js';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { TEST_REDIS_URL } from './env.js';

let app: FastifyInstance;
let dbHandle: DbHandle;
let workerDb: ReturnType<typeof createWorkerDb>;
let redis: Redis;
let scheduler: BullMqSchedulerService;
let worker: Worker;
let site: http.Server;
let siteUrl: string;
let artifactsRoot: string;

beforeAll(async () => {
  const config = makeTestConfig();
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-smoke-'));

  // Local healthy target.
  site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Smoke</title></head><body><h1>OK</h1></body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

  // Real API with the real BullMQ scheduler.
  dbHandle = createDb(config.DATABASE_URL, { max: 5 });
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  scheduler = new BullMqSchedulerService(redis, dbHandle.db, pino({ level: 'silent' }));
  app = await buildApp({ config, dbHandle, redis, scheduler });
  await app.ready();
  await resetDb({ app, dbHandle, redis, scheduler: scheduler as never, config });

  // Real worker consuming the checks queue.
  const workerConfig: WorkerConfig = {
    NODE_ENV: 'test',
    DATABASE_URL: config.DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    ARTIFACTS_DIR: artifactsRoot,
    WORKER_CONCURRENCY: 2,
    ENCRYPTION_KEY: config.ENCRYPTION_KEY,
    MAX_JITTER_MS: 0,
    workerId: 'smoke-worker',
  };
  workerDb = createWorkerDb(config.DATABASE_URL, { max: 5 });
  const processor = createProcessor({
    db: workerDb.db,
    redis,
    config: workerConfig,
    log: pino({ level: 'silent' }),
    store: new ArtifactStore(artifactsRoot),
  });
  worker = new Worker(QUEUE_NAMES.checks, (job) => processor.process(job), {
    connection: redis,
    concurrency: 2,
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker?.close();
  // Drop the smoke app's repeatable + any stray jobs so no other suite sharing
  // this Redis picks them up against a truncated DB.
  const q = new Queue(QUEUE_NAMES.checks, { connection: redis });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
  await scheduler?.close();
  await app?.close();
  await closeBrowser();
  await dbHandle?.sql.end({ timeout: 5 });
  await workerDb?.sql.end({ timeout: 5 });
  redis?.disconnect();
  await new Promise<void>((r) => site.close(() => r()));
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

describe('full-stack smoke', () => {
  it('login → enroll app → run now → run persisted', async () => {
    // 1. login
    const { accessToken } = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(accessToken).toBeTruthy();

    // 2. enroll app (auto-creates the default uptime check + schedule)
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(accessToken),
      payload: { name: 'Smoke app', landingUrl: siteUrl, intervalMinutes: 60 },
    });
    expect(created.statusCode).toBe(201);
    const appBody = created.json();
    const checkId = appBody.checks[0].id as string;

    // 3. run now → 202 { runId }
    const runNow = await app.inject({
      method: 'POST',
      url: `/api/v1/checks/${checkId}/run`,
      headers: authHeader(accessToken),
    });
    expect(runNow.statusCode).toBe(202);
    const runId = runNow.json().runId as string;
    expect(runId).toBeTruthy();

    // 4. the worker executes it and it appears via the API
    let run: Record<string, unknown> | null = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers: authHeader(accessToken) });
      if (res.statusCode === 200) {
        run = res.json();
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(run, 'run should be persisted by the worker').not.toBeNull();
    expect(run!.status).toBe('passed');
    expect((run!.metrics as Record<string, unknown>).httpStatus).toBe(200);

    // And it shows up in the check's run history.
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/checks/${checkId}/runs`,
      headers: authHeader(accessToken),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().runs.some((r: { id: string }) => r.id === runId)).toBe(true);
  }, 90_000);
});
