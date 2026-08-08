// Push (heartbeat) check evaluation.
//
// Inverts the usual direction: Vyzus does not reach the target, the target
// reports in. The check's scheduled run therefore asks a question about time
// rather than performing a network probe — which is why everything downstream
// (runs, incidents, alerts, app status) needs no special case.
//
// Pure, so the staleness rule is testable without a clock or a database.

export interface PushEvaluation {
  /** false once the ping is overdue by more than the grace allowance. */
  alive: boolean;
  /** Seconds since the last ping, or since the check was created if none. */
  silentForSeconds: number;
  /** interval + grace, in seconds — the deadline actually applied. */
  deadlineSeconds: number;
}

export interface PushInput {
  now: Date;
  /** Last received ping; null when the job has never reported in. */
  lastPingAt: Date | null;
  intervalMinutes: number;
  graceMinutes: number;
  /**
   * When Vyzus started expecting pings (the check's creation). Used only when
   * nothing has ever arrived — otherwise a newly created check would be failing
   * before its job has had a chance to run once.
   */
  since: Date;
}

export function evaluatePush(input: PushInput): PushEvaluation {
  const { now, lastPingAt, intervalMinutes, graceMinutes, since } = input;
  const reference = lastPingAt ?? since;
  const silentForSeconds = Math.max(0, Math.floor((now.getTime() - reference.getTime()) / 1000));
  const deadlineSeconds = (intervalMinutes + graceMinutes) * 60;
  return { alive: silentForSeconds <= deadlineSeconds, silentForSeconds, deadlineSeconds };
}

/** Human-readable reason for a failed run, so the alert says what happened. */
export function pushFailureMessage(evaluation: PushEvaluation, lastPingAt: Date | null): string {
  const mins = Math.floor(evaluation.silentForSeconds / 60);
  const overdue = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const deadline = Math.round(evaluation.deadlineSeconds / 60);
  return lastPingAt
    ? `No heartbeat for ${overdue} (expected at least every ${deadline}m). Last ping ${lastPingAt.toISOString()}.`
    : `No heartbeat ever received; ${overdue} since this check was created (expected at least every ${deadline}m).`;
}
