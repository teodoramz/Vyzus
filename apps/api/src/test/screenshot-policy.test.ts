// Pure policy logic — no browser, no DB. Covers the decision table for every
// screenshot mode plus the periodic-refresh cadence.
import { describe, expect, it } from 'vitest';
import { shouldCaptureScreenshot } from '@vyzus/shared';
import type { RunStatus, ScreenshotMode } from '@vyzus/shared';

const NOW = new Date('2026-08-06T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function decide(over: {
  mode: ScreenshotMode;
  status: RunStatus;
  previousStatus?: RunStatus | null;
  refreshMinutes?: number;
  lastScreenshotAt?: Date | null;
}) {
  return shouldCaptureScreenshot({
    mode: over.mode,
    status: over.status,
    // `in` rather than `??` so an explicitly-passed null (never captured)
    // is honoured instead of falling back to the default.
    previousStatus: 'previousStatus' in over ? (over.previousStatus ?? null) : 'passed',
    refreshMinutes: over.refreshMinutes,
    lastScreenshotAt: 'lastScreenshotAt' in over ? (over.lastScreenshotAt ?? null) : minutesAgo(5),
    now: NOW,
  });
}

describe('shouldCaptureScreenshot', () => {
  it('never captures in never mode, even on failure', () => {
    expect(decide({ mode: 'never', status: 'failed' })).toBe(false);
    expect(decide({ mode: 'never', status: 'passed' })).toBe(false);
  });

  it('always captures in always mode, whatever the outcome', () => {
    expect(decide({ mode: 'always', status: 'passed' })).toBe(true);
    expect(decide({ mode: 'always', status: 'failed' })).toBe(true);
  });

  it('captures every non-passing outcome in on_failure and on_change', () => {
    for (const mode of ['on_failure', 'on_change'] as const) {
      for (const status of ['failed', 'error', 'timeout'] as const) {
        expect(decide({ mode, status })).toBe(true);
      }
    }
  });

  it('on_change captures the recovery run; on_failure does not', () => {
    const recovery = { status: 'passed' as const, previousStatus: 'failed' as const };
    expect(decide({ mode: 'on_change', ...recovery })).toBe(true);
    expect(decide({ mode: 'on_failure', ...recovery })).toBe(false);
  });

  it('does not treat a check that has never run as a recovery', () => {
    // previousStatus null means "first run ever" — passing is not a recovery,
    // otherwise every new check would burn a screenshot on its first success.
    expect(decide({ mode: 'on_change', status: 'passed', previousStatus: null })).toBe(false);
  });

  it('leaves consecutive healthy runs alone when no refresh cadence is set', () => {
    expect(decide({ mode: 'on_change', status: 'passed', previousStatus: 'passed' })).toBe(false);
    expect(decide({ mode: 'on_failure', status: 'passed', previousStatus: 'passed' })).toBe(false);
  });

  describe('periodic refresh', () => {
    it('refreshes a healthy run once the stored screenshot is older than the cadence', () => {
      expect(
        decide({ mode: 'on_change', status: 'passed', refreshMinutes: 60, lastScreenshotAt: minutesAgo(61) }),
      ).toBe(true);
    });

    it('holds off while the stored screenshot is still fresh', () => {
      expect(
        decide({ mode: 'on_change', status: 'passed', refreshMinutes: 60, lastScreenshotAt: minutesAgo(59) }),
      ).toBe(false);
    });

    it('fires exactly at the cadence boundary', () => {
      expect(
        decide({ mode: 'on_change', status: 'passed', refreshMinutes: 60, lastScreenshotAt: minutesAgo(60) }),
      ).toBe(true);
    });

    it('captures when nothing has ever been stored', () => {
      expect(decide({ mode: 'on_change', status: 'passed', refreshMinutes: 60, lastScreenshotAt: null })).toBe(true);
    });

    it('applies to on_failure too', () => {
      expect(
        decide({ mode: 'on_failure', status: 'passed', refreshMinutes: 30, lastScreenshotAt: minutesAgo(31) }),
      ).toBe(true);
    });

    it('is ignored by never mode', () => {
      expect(decide({ mode: 'never', status: 'passed', refreshMinutes: 1, lastScreenshotAt: minutesAgo(999) })).toBe(
        false,
      );
    });
  });
});
