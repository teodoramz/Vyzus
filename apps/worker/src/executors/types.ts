// Result shape every executor returns; the job processor persists it (or, for
// dry-runs, returns it inline).
import type { RunStatus } from '@vyzus/shared';

export interface ExecutionResult {
  status: RunStatus;
  durationMs: number;
  metrics: Record<string, unknown> | null;
  errorMessage: string | null;
  /** Relative artifact paths (null when not captured / dry-run). */
  screenshotPath: string | null;
  tracePath: string | null;
}

/** Where an executor may persist artifacts; omitted for dry-runs. */
export interface ArtifactTarget {
  appId: string;
  runId: string;
}

export const ERROR_MESSAGE_LIMIT = 4 * 1024;

export function truncateError(message: string): string {
  return message.length > ERROR_MESSAGE_LIMIT ? `${message.slice(0, ERROR_MESSAGE_LIMIT - 1)}…` : message;
}
