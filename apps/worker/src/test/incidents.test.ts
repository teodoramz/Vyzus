// Incident state machine against real Postgres.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { incidents } from '@vyzus/shared/db';
import { evaluateIncident } from '../incidents.js';
import { connectDb, truncateAll, seedAppWithCheck, insertRun, startTestSite, type TestSite } from './helpers.js';
import type { WorkerDbHandle } from '../db.js';

let handle: WorkerDbHandle;
let site: TestSite;

beforeAll(async () => {
  handle = connectDb();
  site = await startTestSite();
});

afterAll(async () => {
  await site.close();
  await handle.sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await truncateAll(handle);
});

describe('evaluateIncident', () => {
  it('opens an incident only at failure_threshold consecutive failures', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, { failureThreshold: 2 });

    const run1 = await insertRun(handle, check.id, 'failed');
    const t1 = await evaluateIncident(handle.db, check, { id: run1.id, status: 'failed', startedAt: run1.startedAt });
    expect(t1.opened).toBeNull(); // 1 < threshold 2

    const run2 = await insertRun(handle, check.id, 'failed');
    const t2 = await evaluateIncident(handle.db, check, { id: run2.id, status: 'failed', startedAt: run2.startedAt });
    expect(t2.opened).not.toBeNull();
    expect(t2.opened!.checkId).toBe(check.id);
    expect(t2.opened!.openingRunId).toBe(run2.id);

    // Third failure: incident already open — no duplicate.
    const run3 = await insertRun(handle, check.id, 'timeout');
    const t3 = await evaluateIncident(handle.db, check, { id: run3.id, status: 'timeout', startedAt: run3.startedAt });
    expect(t3.opened).toBeNull();

    const open = await handle.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.checkId, check.id), isNull(incidents.resolvedAt)));
    expect(open).toHaveLength(1);
  });

  it('resolves the incident on the first success and reports downtime', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, { failureThreshold: 1 });

    const failRun = await insertRun(handle, check.id, 'error');
    const opened = await evaluateIncident(handle.db, check, {
      id: failRun.id,
      status: 'error',
      startedAt: failRun.startedAt,
    });
    expect(opened.opened).not.toBeNull();

    const okRun = await insertRun(handle, check.id, 'passed');
    const resolved = await evaluateIncident(handle.db, check, {
      id: okRun.id,
      status: 'passed',
      startedAt: okRun.startedAt,
    });
    expect(resolved.resolved).not.toBeNull();
    expect(resolved.resolved!.incident.id).toBe(opened.opened!.id);
    expect(resolved.resolved!.incident.resolvingRunId).toBe(okRun.id);
    expect(resolved.resolved!.downtimeSeconds).toBeGreaterThanOrEqual(0);

    // Success with nothing open is a no-op.
    const okRun2 = await insertRun(handle, check.id, 'passed');
    const noop = await evaluateIncident(handle.db, check, {
      id: okRun2.id,
      status: 'passed',
      startedAt: okRun2.startedAt,
    });
    expect(noop.opened).toBeNull();
    expect(noop.resolved).toBeNull();
  });

  it('success resets the consecutive-failures counter', async () => {
    const { check } = await seedAppWithCheck(handle, site.url, { failureThreshold: 3 });
    const r1 = await insertRun(handle, check.id, 'failed');
    await evaluateIncident(handle.db, check, { id: r1.id, status: 'failed', startedAt: r1.startedAt });
    const r2 = await insertRun(handle, check.id, 'passed');
    await evaluateIncident(handle.db, check, { id: r2.id, status: 'passed', startedAt: r2.startedAt });

    // Two more failures — still below threshold because the counter reset.
    const r3 = await insertRun(handle, check.id, 'failed');
    await evaluateIncident(handle.db, check, { id: r3.id, status: 'failed', startedAt: r3.startedAt });
    const r4 = await insertRun(handle, check.id, 'failed');
    const t = await evaluateIncident(handle.db, check, { id: r4.id, status: 'failed', startedAt: r4.startedAt });
    expect(t.opened).toBeNull();
  });
});
