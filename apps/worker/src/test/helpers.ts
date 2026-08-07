import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { applications, checks, runs } from '@vyzus/shared/db';
import type { HttpModeConfig } from '@vyzus/shared';
import { createWorkerDb, type WorkerDbHandle } from '../db.js';
import type { WorkerConfig } from '../config.js';
import { TEST_DATABASE_URL } from './env.js';

/** Tiny controllable HTTP target for uptime/journey tests. */
export interface TestSite {
  url: string;
  /** Flip to make the server return 503 (simulates the target dying). */
  setDown(down: boolean): void;
  /** Flip the page's look without changing status or structure — a defacement
   * or broken-CSS deploy, which only a pixel comparison can see. */
  setRepainted(repainted: boolean): void;
  /** Headers of the most recent request the server actually received —
   * lets a test assert the real outbound fingerprint (UA, Accept-Language)
   * rather than trusting the options passed into newContext. */
  lastRequestHeaders(): http.IncomingHttpHeaders | null;
  close(): Promise<void>;
}

export async function startTestSite(): Promise<TestSite> {
  let down = false;
  let repainted = false;
  let lastHeaders: http.IncomingHttpHeaders | null = null;
  const server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (down) {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Service Unavailable</h1></body></html>');
      return;
    }
    if (req.url === '/slow') {
      // Never responds — navigation timeout path.
      return;
    }
    if (req.url === '/lag') {
      // Responds, but only after a beat — the latency-threshold path, which
      // needs a run that genuinely passes every assertion yet is slow.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Test Site</title></head><body><h1 id="hero">slow but fine</h1></body></html>');
      }, 900);
      return;
    }
    if (req.url === '/echo-ua') {
      // Renders what the server actually received + what the page sees, so a
      // test can assert the real request fingerprint rather than trusting the
      // context options we passed in.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Echo</title></head><body>' +
          `<div id="ua">${req.headers['user-agent'] ?? ''}</div>` +
          `<div id="lang">${req.headers['accept-language'] ?? ''}</div>` +
          '<div id="webdriver"></div>' +
          '<script>document.getElementById("webdriver").textContent = String(navigator.webdriver);</script>' +
          '</body></html>',
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>Test Site</title></head>' +
        `<body style="background:${repainted ? '#000' : '#fff'};color:${repainted ? '#fff' : '#000'}">` +
        '<h1 id="hero">Vyzus test target</h1>' +
        '<p>Welcome to the demo shop.</p>' +
        '<a href="/about">About</a>' +
        '</body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    setDown(v: boolean) {
      down = v;
    },
    setRepainted(v: boolean) {
      repainted = v;
    },
    lastRequestHeaders: () => lastHeaders,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function testWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380',
    ARTIFACTS_DIR: '/tmp/vyzus-test-artifacts',
    WORKER_CONCURRENCY: 2,
    ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    MAX_JITTER_MS: 0, // deterministic tests
    workerId: 'test-worker',
    ...overrides,
  };
}

export function connectDb(): WorkerDbHandle {
  return createWorkerDb(TEST_DATABASE_URL, { max: 5 });
}

export async function truncateAll(handle: WorkerDbHandle): Promise<void> {
  await handle.sql.unsafe(
    'TRUNCATE alert_deliveries, app_alert_channels, alert_channels, incidents, runs, checks, applications, settings, users RESTART IDENTITY CASCADE',
  );
}

/** Insert an app + uptime check pointing at `url`; returns their rows. */
export async function seedAppWithCheck(
  handle: WorkerDbHandle,
  url: string,
  checkOverrides: Partial<typeof checks.$inferInsert> = {},
  uptimeConfig: Partial<HttpModeConfig> = {},
) {
  const [app] = await handle.db
    .insert(applications)
    .values({ name: 'Test app', landingUrl: url, tags: [] })
    .returning();
  const [check] = await handle.db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'Uptime',
      intervalMinutes: 1,
      timeoutMs: 10_000,
      failureThreshold: 2,
      config: {
        mode: 'http',
        expectedStatus: 200,
        screenshot: 'on_failure',
        maxDurationMs: 0,
        visualDiffPercent: 0,
        ...uptimeConfig,
      },
      ...checkOverrides,
    })
    .returning();
  return { app: app!, check: check! };
}

/** Insert a run row (needed before evaluateIncident — FK on opening_run_id). */
export async function insertRun(
  handle: WorkerDbHandle,
  checkId: string,
  status: 'passed' | 'failed' | 'error' | 'timeout',
) {
  const [run] = await handle.db
    .insert(runs)
    .values({
      id: randomUUID(),
      checkId,
      status,
      trigger: 'schedule',
      startedAt: new Date(),
      durationMs: 100,
    })
    .returning();
  return run!;
}
