// Artifact storage module. Everything the platform knows about artifact
// placement lives here (05-infrastructure: swap this module to move to S3).
// Layout: <ARTIFACTS_DIR>/<appId>/<runId>/{screenshot.png,trace.zip}; the DB
// stores paths relative to ARTIFACTS_DIR.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SCREENSHOT_FILENAME = 'screenshot.png';
export const TRACE_FILENAME = 'trace.zip';

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  /** Absolute directory for a run's artifacts (created on demand). */
  async ensureRunDir(appId: string, runId: string): Promise<string> {
    const dir = path.join(this.rootDir, appId, runId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Relative path (as stored in the DB) for a run artifact. */
  relativePath(appId: string, runId: string, filename: string): string {
    return path.join(appId, runId, filename);
  }

  absolutePath(relPath: string): string {
    return path.join(this.rootDir, relPath);
  }

  async writeScreenshot(appId: string, runId: string, png: Buffer): Promise<string> {
    await this.ensureRunDir(appId, runId);
    const rel = this.relativePath(appId, runId, SCREENSHOT_FILENAME);
    await fs.writeFile(this.absolutePath(rel), png);
    return rel;
  }

  /** Returns the relative path if the file exists (used after the sandbox ran). */
  async existingArtifact(appId: string, runId: string, filename: string): Promise<string | null> {
    const rel = this.relativePath(appId, runId, filename);
    try {
      await fs.access(this.absolutePath(rel));
      return rel;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort delete of a single artifact file (screenshot streak dedup —
   * processor.ts). Never throws: a missing/already-cleaned-up file (e.g. by
   * retention) is not an error.
   */
  async deleteFile(relPath: string): Promise<void> {
    await fs.rm(this.absolutePath(relPath), { force: true }).catch(() => undefined);
  }
}
