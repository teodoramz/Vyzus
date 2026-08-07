// Dead-man's switch for the monitoring platform itself.
//
// If the worker container dies, checks stop running. Nothing fails, so no
// incident opens and no alert fires; the dashboard keeps serving the last
// known status indefinitely. Silence is indistinguishable from health, which
// is the one failure mode that invalidates every other signal the platform
// produces.
//
// The decision is a pure function so it can be reasoned about and tested
// without a database, a clock, or a queue.
import { HEARTBEAT_INTERVAL_MULTIPLE } from './constants.js';

export interface HeartbeatInput {
  now: Date;
  /** Most recent finished run across the whole platform, or null if none ever. */
  lastRunAt: Date | null;
  /** Number of enabled checks on enabled applications. */
  enabledChecks: number;
  /** Shortest interval among those checks, in minutes. null when there are none. */
  shortestIntervalMinutes: number | null;
  /** Configured threshold; 0 disables the switch entirely. */
  stallMinutes: number;
  /**
   * When the platform started caring. Used only when no run has ever finished,
   * so a fresh deployment is not declared stalled before its first check is due.
   */
  since: Date;
}

export interface HeartbeatVerdict {
  stalled: boolean;
  /** Seconds of silence measured against `lastRunAt` (or `since` if none). */
  silentForSeconds: number;
  /** The threshold actually applied, in minutes, after the interval guard. */
  effectiveThresholdMinutes: number;
}

/**
 * A stall requires silence longer than BOTH the configured threshold and
 * `HEARTBEAT_INTERVAL_MULTIPLE` times the shortest enabled interval. The
 * second condition is what stops a deployment whose only check runs hourly
 * from alerting every 15 minutes forever.
 */
export function evaluateHeartbeat(input: HeartbeatInput): HeartbeatVerdict {
  const { now, lastRunAt, enabledChecks, shortestIntervalMinutes, stallMinutes, since } = input;

  // Measured from the last run, or from when we started watching if nothing has
  // ever run — otherwise a brand-new deployment reads as infinitely silent.
  const reference = lastRunAt ?? since;
  const silentForSeconds = Math.max(0, Math.floor((now.getTime() - reference.getTime()) / 1000));

  const intervalFloor = (shortestIntervalMinutes ?? 0) * HEARTBEAT_INTERVAL_MULTIPLE;
  const effectiveThresholdMinutes = Math.max(stallMinutes, intervalFloor);

  // Disabled, or nothing is supposed to be running — silence is then correct,
  // not a fault. Both are reported with the same shape so callers need no
  // special case.
  if (stallMinutes <= 0 || enabledChecks === 0) {
    return { stalled: false, silentForSeconds, effectiveThresholdMinutes };
  }

  return {
    stalled: silentForSeconds > effectiveThresholdMinutes * 60,
    silentForSeconds,
    effectiveThresholdMinutes,
  };
}
