// Push (heartbeat) executor. Unlike every other executor this performs no
// network I/O at all — the target already reported in, or it did not. The run
// simply records which.
//
// Modelling it as a normal scheduled run is what keeps the rest of the system
// unchanged: incidents, alerts, availability, run history and the WS feed all
// work because a push check produces runs like anything else.
import { evaluatePush, pushFailureMessage, type PushConfig } from '@vyzus/shared';
import type { ExecutionResult } from './types.js';

export interface PushInput {
  config: PushConfig;
  intervalMinutes: number;
  /** Last ping received, from `checks.last_ping_at`. */
  lastPingAt: Date | null;
  /** Check creation — the deadline anchor before any ping has arrived. */
  createdAt: Date;
  now?: Date;
}

export function executePush(input: PushInput): ExecutionResult {
  const now = input.now ?? new Date();
  const evaluation = evaluatePush({
    now,
    lastPingAt: input.lastPingAt,
    intervalMinutes: input.intervalMinutes,
    graceMinutes: input.config.graceMinutes,
    since: input.createdAt,
  });

  return {
    status: evaluation.alive ? 'passed' : 'failed',
    // Not a network duration — this executor does no I/O. Reporting the silence
    // instead would make the response-time chart meaningless for these checks.
    durationMs: 0,
    metrics: {
      lastPingAt: input.lastPingAt ? input.lastPingAt.toISOString() : null,
      silentForSeconds: evaluation.silentForSeconds,
      deadlineSeconds: evaluation.deadlineSeconds,
    },
    errorMessage: evaluation.alive ? null : pushFailureMessage(evaluation, input.lastPingAt),
    screenshotPath: null,
    tracePath: null,
  };
}
