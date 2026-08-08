// Re-notification for incidents that are still open.
//
// Vyzus alerts once on the down transition and then goes quiet until recovery.
// A single message into a busy Slack channel at 02:00 is an outage nobody sees,
// so an open incident is re-announced on a cadence until it resolves.
//
// Pure, so the cadence rule can be reasoned about without a database or a clock.

export interface RenotifyCandidate {
  incidentId: string;
  openedAt: Date;
  /** Last notification sent for this incident — the original alert or a reminder. */
  lastNotifiedAt: Date | null;
}

export interface RenotifyInput {
  now: Date;
  /** Cadence in minutes; 0 disables re-notification entirely. */
  renotifyMinutes: number;
  candidates: readonly RenotifyCandidate[];
}

/**
 * Which open incidents are due a reminder.
 *
 * Measured from `lastNotifiedAt` so the cadence is "every N minutes since you
 * were last told", not "every N minutes since it broke" — otherwise an incident
 * whose first alert was delayed would immediately fire a burst of catch-up
 * reminders.
 *
 * `lastNotifiedAt` is null for incidents that predate the column; those fall
 * back to `openedAt`, which is the closest honest approximation of when someone
 * was last told.
 */
export function dueForRenotify(input: RenotifyInput): RenotifyCandidate[] {
  const { now, renotifyMinutes, candidates } = input;
  if (renotifyMinutes <= 0) return [];

  const intervalMs = renotifyMinutes * 60 * 1000;
  return candidates.filter((c) => {
    const since = c.lastNotifiedAt ?? c.openedAt;
    return now.getTime() - since.getTime() >= intervalMs;
  });
}
