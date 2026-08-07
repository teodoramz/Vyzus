// Maintenance windows: planned-work alert suppression.
//
// Suppression applies to notification only. Checks keep running and every run
// is recorded, so history stays honest and the dead-man's switch — which
// watches for runs *stopping* — is unaffected. A window that paused execution
// would trip it.
//
// Pure so the rule can be reasoned about and tested without a database or a
// clock.

export interface MaintenanceWindowLike {
  /** null = platform-wide; otherwise scoped to this application. */
  appId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

/**
 * The window that suppresses an alert for `appId` at `now`, or null.
 *
 * Half-open [startsAt, endsAt): a window ending at 03:00 and another starting
 * at 03:00 leave no unsuppressed instant between them, and neither does a
 * single window double-cover its own boundary.
 */
export function activeMaintenanceWindow<T extends MaintenanceWindowLike>(
  windows: readonly T[],
  appId: string,
  now: Date,
): T | null {
  const t = now.getTime();
  for (const w of windows) {
    if (w.appId !== null && w.appId !== appId) continue;
    if (t >= w.startsAt.getTime() && t < w.endsAt.getTime()) return w;
  }
  return null;
}
