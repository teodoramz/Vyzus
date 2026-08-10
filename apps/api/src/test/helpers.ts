import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../config.js';
import { createDb, type DbHandle } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { buildApp } from '../app.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { CheckRow } from '../db/schema.js';
import type { DryRunJobPayload, DryRunResult, RunTrigger } from '@vyzus/shared';
import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './env.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'admin-dev-password-1';

export function makeTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    PUBLIC_URL: 'http://localhost:8080',
    ...overrides,
  });
}

/** Scheduler test double that records every call so tests can assert wiring. */
export class MockScheduler implements SchedulerService {
  syncCalls: { checkId: string; enabled: boolean; appEnabled: boolean }[] = [];
  removeCalls: string[] = [];
  removeAppCalls: string[][] = [];
  enqueueCalls: { checkId: string; trigger: RunTrigger; runId: string }[] = [];
  dryRunCalls: DryRunJobPayload[] = [];
  reconcileCount = 0;
  queueDepth = 0;

  async syncCheck(check: CheckRow, appEnabled: boolean): Promise<void> {
    this.syncCalls.push({ checkId: check.id, enabled: check.enabled, appEnabled });
  }
  async removeCheck(checkId: string): Promise<void> {
    this.removeCalls.push(checkId);
  }
  async removeChecksForApp(checkIds: string[]): Promise<void> {
    this.removeAppCalls.push(checkIds);
  }
  async enqueueRun(checkId: string, trigger: RunTrigger): Promise<{ runId: string }> {
    const runId = randomUUID();
    this.enqueueCalls.push({ checkId, trigger, runId });
    return { runId };
  }
  async reconcileSchedules(): Promise<void> {
    this.reconcileCount += 1;
  }
  async getQueueDepth(): Promise<number> {
    return this.queueDepth;
  }
  async dryRun(payload: DryRunJobPayload, _budgetMs: number): Promise<DryRunResult> {
    this.dryRunCalls.push(payload);
    return { status: 'passed', durationMs: 42, metrics: null, errorMessage: null };
  }
  async close(): Promise<void> {
    // nothing to release
  }
}

export interface TestContext {
  app: FastifyInstance;
  dbHandle: DbHandle;
  redis: Redis;
  scheduler: MockScheduler;
  config: AppConfig;
}

export async function buildTestApp(envOverrides: NodeJS.ProcessEnv = {}): Promise<TestContext> {
  const config = makeTestConfig(envOverrides);
  const dbHandle = createDb(config.DATABASE_URL, { max: 5 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  const scheduler = new MockScheduler();
  const app = await buildApp({ config, dbHandle, redis, scheduler });
  await app.ready();
  return { app, dbHandle, redis, scheduler, config };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.dbHandle.sql.end({ timeout: 5 });
  ctx.redis.disconnect();
}

const ALL_TABLES = [
  'alert_deliveries',
  'app_alert_channels',
  'alert_channels',
  'incidents',
  'runs',
  'checks',
  'applications',
  'settings',
  'users',
];

/**
 * Insert the fixture admin the suite logs in as. The product itself has no
 * env-seeded admin any more — a real install creates its first user through
 * POST /auth/setup — so tests own this fixture directly rather than going
 * through a production code path that no longer exists.
 */
export async function seedTestAdmin(ctx: TestContext): Promise<void> {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await ctx.dbHandle.db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, role: 'admin' }).onConflictDoNothing();
}

export async function resetDb(ctx: TestContext): Promise<void> {
  await ctx.dbHandle.sql.unsafe(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // Throttle counters and the status-page cache live in Redis, not Postgres, so
  // truncating alone leaves them behind: a file that exhausts the login budget
  // locks out every later file with a 429, and a stale cached status page
  // outlives the rows it was built from. Redis is part of the isolation
  // boundary too.
  const keys = await ctx.redis.keys('vyzus:login-throttle:*');
  const statusKeys = await ctx.redis.keys('vyzus:status-*');
  const stale = [...keys, ...statusKeys];
  if (stale.length > 0) await ctx.redis.del(...stale);
  await seedTestAdmin(ctx);
}

/** Log in and return the access token plus the raw refresh cookie value. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshCookie: string; status: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === 'refreshToken');
  return {
    accessToken: (body as { accessToken?: string }).accessToken ?? '',
    refreshCookie: cookie?.value ?? '',
    status: res.statusCode,
    body,
  };
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
