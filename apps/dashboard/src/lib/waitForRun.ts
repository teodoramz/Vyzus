// Run rows are only inserted after the worker finishes executing
// (processor.ts) — never in a "pending" state — so polling GET /runs/:id
// until it stops 404ing *is* waiting for completion, no separate status field
// to watch. Used so a run-now/screenshot-now button's busy state lasts the
// run's real duration instead of clearing the instant the enqueue POST
// resolves (which is near-instant and easy to miss).
import { ApiError } from '../api/http';
import { runsApi } from '../api/endpoints';

const POLL_INTERVAL_MS = 600;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function waitForRunCompletion(runId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await runsApi.get(runId);
      return;
    } catch (err) {
      const notFoundYet = err instanceof ApiError && err.status === 404;
      // Give up quietly on a real error or timeout — the button just stops
      // waiting; the run itself is unaffected either way.
      if (!notFoundYet || Date.now() >= deadline) return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
