// Demo seed (Phase 7 / FR): three example applications so a fresh install shows
// something immediately —
//   1. Healthy    : https://example.com (uptime, passes)
//   2. Down        : http://127.0.0.1:9 (uptime, connection refused → incident/alert demo)
//   3. Journey     : example.com with an uptime + a journey check
// Idempotent: apps are keyed by name; re-running touches nothing already present.
// Registers each check's schedule so runs begin without an API restart.
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import type { UptimeConfig, JourneyConfig } from '@vyzus/shared';
import { loadConfig } from './config.js';
import { createDb, type Database } from './db/index.js';
import { applications, checks, type CheckRow } from './db/schema.js';
import { BullMqSchedulerService } from './services/scheduler.js';

interface DemoCheck {
  type: 'uptime' | 'journey';
  name: string;
  intervalMinutes: number;
  timeoutMs?: number;
  failureThreshold?: number;
  config: UptimeConfig | JourneyConfig;
}

interface DemoApp {
  name: string;
  landingUrl: string;
  tags: string[];
  checks: DemoCheck[];
}

const DEMO: DemoApp[] = [
  {
    name: 'Example (healthy)',
    landingUrl: 'https://example.com',
    tags: ['demo', 'healthy'],
    checks: [
      {
        type: 'uptime',
        name: 'Landing uptime',
        intervalMinutes: 1,
        config: { mode: 'http', expectedStatus: 200, bodyText: 'Example Domain', screenshot: 'always' },
      },
    ],
  },
  {
    name: 'Down demo',
    landingUrl: 'http://127.0.0.1:9',
    tags: ['demo', 'down'],
    checks: [
      {
        type: 'uptime',
        name: 'Landing uptime',
        intervalMinutes: 1,
        failureThreshold: 2,
        config: { mode: 'http', expectedStatus: 200, screenshot: 'on_failure' },
      },
    ],
  },
  {
    name: 'Journey demo',
    landingUrl: 'https://example.com',
    tags: ['demo', 'journey'],
    checks: [
      {
        type: 'uptime',
        name: 'Landing uptime',
        intervalMinutes: 5,
        config: { mode: 'http', expectedStatus: 200, screenshot: 'always' },
      },
      {
        type: 'journey',
        name: 'Homepage journey',
        intervalMinutes: 10,
        timeoutMs: 45_000,
        config: {
          specSource: [
            "await page.goto('https://example.com/');",
            "await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
            "await expect(page.locator('body')).toContainText('Example');",
          ].join('\n'),
        },
      },
    ],
  },
];

export async function seedDemo(
  db: Database,
  scheduler: BullMqSchedulerService | null,
  log: { info: (o: unknown, m?: string) => void },
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const demo of DEMO) {
    const [existing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.name, demo.name))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }

    const inserted = await db.transaction(async (tx) => {
      const [appRow] = await tx
        .insert(applications)
        .values({ name: demo.name, landingUrl: demo.landingUrl, tags: demo.tags })
        .returning();
      const checkRows: CheckRow[] = [];
      for (const c of demo.checks) {
        const [checkRow] = await tx
          .insert(checks)
          .values({
            appId: appRow!.id,
            type: c.type,
            name: c.name,
            intervalMinutes: c.intervalMinutes,
            timeoutMs: c.timeoutMs ?? 30_000,
            failureThreshold: c.failureThreshold ?? 2,
            config: c.config,
          })
          .returning();
        checkRows.push(checkRow!);
      }
      return { appRow: appRow!, checkRows };
    });

    if (scheduler) {
      for (const check of inserted.checkRows) await scheduler.syncCheck(check, true);
    }
    created += 1;
    log.info({ app: demo.name, checks: inserted.checkRows.length }, 'seeded demo app');
  }

  return { created, skipped };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: 'info' });
  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const scheduler = new BullMqSchedulerService(redis, db, log);
  try {
    const summary = await seedDemo(db, scheduler, log);
    log.info(summary, 'demo seed complete');
  } finally {
    await scheduler.close();
    await sql.end({ timeout: 5 });
    redis.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('demo seed failed:', err);
    process.exit(1);
  });
}
