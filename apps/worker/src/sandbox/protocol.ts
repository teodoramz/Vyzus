// Shared bits of the parent↔child sandbox protocol. Kept separate from
// runner-harness.ts because importing the harness executes it (it is a script
// entry, never a library).

export const RESULT_MARKER = '@@VYZUS_RESULT@@';

export interface HarnessConfig {
  /** Absolute path of the temp module exporting the wrapped spec. */
  specPath: string;
  /** Absolute dir for failure artifacts; null = discard (dry-run). */
  artifactsDir: string | null;
  timeoutMs: number;
}

export interface HarnessResult {
  status: 'passed' | 'failed' | 'error' | 'timeout';
  durationMs: number;
  errorMessage: string | null;
  screenshotSaved: boolean;
  traceSaved: boolean;
}
