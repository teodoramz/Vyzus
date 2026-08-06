// Single source of truth for "should this run store a screenshot?".
//
// Lives in shared rather than in the worker because the decision depends on
// check *state* (previous status, when the last screenshot was taken) that
// only the job processor has, while the meaning of each mode is part of the
// check contract the API and dashboard also describe. Keeping it here means
// the rule is written once and can be unit-tested without a browser.
import type { RunStatus, ScreenshotMode } from './constants.js';

export interface ScreenshotDecisionInput {
  mode: ScreenshotMode;
  /** Refresh cadence for a passing run; unset disables periodic refresh. */
  refreshMinutes?: number | undefined;
  /** Outcome of the run that just finished. */
  status: RunStatus;
  /** The check's previous `last_status`, or null if it has never run. */
  previousStatus: RunStatus | null;
  /** When this check last stored a screenshot, or null if never. */
  lastScreenshotAt: Date | null;
  /** Now, injectable so tests do not depend on wall-clock timing. */
  now?: Date;
}

/**
 * A run is a "recovery" when it passed and the previous run did not. The very
 * first run of a check is not a recovery — there was nothing to recover from.
 */
function isRecovery(status: RunStatus, previousStatus: RunStatus | null): boolean {
  return status === 'passed' && previousStatus !== null && previousStatus !== 'passed';
}

export function shouldCaptureScreenshot(input: ScreenshotDecisionInput): boolean {
  const { mode, refreshMinutes, status, previousStatus, lastScreenshotAt } = input;
  if (mode === 'never') return false;
  if (mode === 'always') return true;

  // Both remaining modes always capture a failure — that is the evidence.
  if (status !== 'passed') return true;

  // `on_change` additionally captures the moment it came back.
  if (mode === 'on_change' && isRecovery(status, previousStatus)) return true;

  // Otherwise this is a healthy run: capture only if the stored picture has
  // aged past the configured refresh cadence. No cadence set means the
  // screenshot only ever changes on failure/recovery.
  if (refreshMinutes === undefined) return false;
  if (lastScreenshotAt === null) return true; // nothing stored yet
  const now = input.now ?? new Date();
  return now.getTime() - lastScreenshotAt.getTime() >= refreshMinutes * 60_000;
}
