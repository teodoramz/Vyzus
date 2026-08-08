// The push executor performs no I/O — it answers a question about time. These
// assert the run it produces, because that run is what drives incidents,
// alerts, availability and the app badge downstream.
import { describe, expect, it } from 'vitest';
import { executePush } from '../executors/push.js';

const MIN = 60 * 1000;
const now = new Date('2026-08-08T12:00:00Z');
const config = { token: 'a'.repeat(64), graceMinutes: 5 };

describe('executePush', () => {
  it('passes while the heartbeat is current, and records the measurement', () => {
    const result = executePush({
      config,
      intervalMinutes: 60,
      lastPingAt: new Date(now.getTime() - 10 * MIN),
      createdAt: new Date(now.getTime() - 300 * MIN),
      now,
    });
    expect(result.status).toBe('passed');
    expect(result.errorMessage).toBeNull();
    const m = result.metrics as Record<string, unknown>;
    expect(m.silentForSeconds).toBe(600);
    expect(m.deadlineSeconds).toBe(65 * 60);
  });

  it('fails once overdue, and says how long and what was expected', () => {
    const result = executePush({
      config,
      intervalMinutes: 60,
      lastPingAt: new Date(now.getTime() - 120 * MIN),
      createdAt: new Date(now.getTime() - 300 * MIN),
      now,
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/No heartbeat for 2h 0m/);
    expect(result.errorMessage).toMatch(/expected at least every 65m/);
  });

  it('distinguishes "never reported" from "stopped reporting"', () => {
    const result = executePush({
      config,
      intervalMinutes: 60,
      lastPingAt: null,
      createdAt: new Date(now.getTime() - 300 * MIN),
      now,
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/No heartbeat ever received/);
  });

  // A check created a moment ago must not fail before its job can run once.
  it('does not fail a freshly created check', () => {
    const result = executePush({
      config,
      intervalMinutes: 60,
      lastPingAt: null,
      createdAt: new Date(now.getTime() - 1 * MIN),
      now,
    });
    expect(result.status).toBe('passed');
  });

  // durationMs feeds the response-time chart; reporting silence there would
  // make that chart meaningless for these checks.
  it('reports no duration, since it does no network work', () => {
    const result = executePush({ config, intervalMinutes: 60, lastPingAt: null, createdAt: now, now });
    expect(result.durationMs).toBe(0);
    expect(result.screenshotPath).toBeNull();
    expect(result.tracePath).toBeNull();
  });
});
