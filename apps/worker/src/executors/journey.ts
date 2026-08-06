// Journey executor: delegates the user's spec to the sandbox child process
// (never evaluates it in this process — 02-architecture §5.2/§7) and maps the
// harness result onto the common ExecutionResult shape.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JourneyConfig } from '@vyzus/shared';
import { runInSandbox } from '../sandbox/spawn.js';
import { ArtifactStore, SCREENSHOT_FILENAME, TRACE_FILENAME } from '../artifacts.js';
import { truncateError, type ArtifactTarget, type ExecutionResult } from './types.js';

export interface JourneyInput {
  config: JourneyConfig;
  timeoutMs: number;
}

export async function executeJourney(
  input: JourneyInput,
  artifacts?: { store: ArtifactStore; target: ArtifactTarget },
): Promise<ExecutionResult> {
  // Persisted runs get a real artifacts dir; dry-runs use a throwaway temp dir.
  let artifactsDir: string;
  let tempDir: string | null = null;
  if (artifacts) {
    artifactsDir = await artifacts.store.ensureRunDir(artifacts.target.appId, artifacts.target.runId);
  } else {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-dryrun-'));
    artifactsDir = tempDir;
  }

  try {
    const outcome = await runInSandbox({
      specSource: input.config.specSource,
      timeoutMs: input.timeoutMs,
      artifactsDir,
    });

    let screenshotPath: string | null = null;
    let tracePath: string | null = null;
    if (artifacts) {
      const { store, target } = artifacts;
      screenshotPath = outcome.screenshotSaved
        ? await store.existingArtifact(target.appId, target.runId, SCREENSHOT_FILENAME)
        : null;
      tracePath = outcome.traceSaved ? await store.existingArtifact(target.appId, target.runId, TRACE_FILENAME) : null;
    }

    return {
      status: outcome.status,
      durationMs: outcome.durationMs,
      metrics: null,
      errorMessage: outcome.errorMessage ? truncateError(outcome.errorMessage) : null,
      screenshotPath,
      tracePath,
    };
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
