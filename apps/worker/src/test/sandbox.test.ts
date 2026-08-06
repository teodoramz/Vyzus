// Phase 4 acceptance: sandboxed journey execution.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runInSandbox } from '../sandbox/spawn.js';
import { executeJourney } from '../executors/journey.js';
import { ArtifactStore, SCREENSHOT_FILENAME, TRACE_FILENAME } from '../artifacts.js';
import { startTestSite, type TestSite } from './helpers.js';

let site: TestSite;
let artifactsRoot: string;

beforeAll(async () => {
  site = await startTestSite();
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-artifacts-'));
  // The env-cleanliness test asserts the child cannot see this.
  process.env.DATABASE_URL = 'postgres://secret:secret@nowhere:5432/platform';
});

afterAll(async () => {
  await site.close();
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

describe('journey sandbox (spawned child process)', () => {
  it('runs a codegen-style spec to success', async () => {
    const outcome = await runInSandbox({
      specSource: [
        `await page.goto(${JSON.stringify(site.url)});`,
        `await page.getByRole('heading', { name: 'Vyzus test target' }).click();`,
        `await expect(page.locator('#hero')).toBeVisible();`,
        `await expect(page.getByText('Welcome to the demo shop.')).toBeVisible();`,
      ].join('\n'),
      timeoutMs: 30_000,
      artifactsDir: null,
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.errorMessage).toBeNull();
    expect(outcome.hardKilled).toBe(false);
  });

  it('classifies a failing expect() as failed and saves screenshot + trace', async () => {
    const dir = path.join(artifactsRoot, 'failing');
    await fs.mkdir(dir, { recursive: true });
    const outcome = await runInSandbox({
      specSource: [
        `await page.goto(${JSON.stringify(site.url)});`,
        `await expect(page.getByText('THIS TEXT DOES NOT EXIST')).toBeVisible({ timeout: 2000 });`,
      ].join('\n'),
      timeoutMs: 30_000,
      artifactsDir: dir,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toContain('THIS TEXT DOES NOT EXIST');
    expect(outcome.screenshotSaved).toBe(true);
    expect(outcome.traceSaved).toBe(true);
    const files = await fs.readdir(dir);
    expect(files).toContain('screenshot.png');
    expect(files).toContain('trace.zip');
    const trace = await fs.stat(path.join(dir, 'trace.zip'));
    expect(trace.size).toBeGreaterThan(1000);
  });

  it('kills a while(true) spec at the timeout and records timeout', async () => {
    const started = Date.now();
    const outcome = await runInSandbox({
      specSource: 'while (true) {} // blocks the event loop — soft timeout cannot fire',
      timeoutMs: 5_000,
      artifactsDir: null,
    });
    const elapsed = Date.now() - started;
    expect(outcome.status).toBe('timeout');
    expect(outcome.hardKilled).toBe(true);
    // hard kill at timeoutMs + HARD_KILL_GRACE_MS, plus teardown slack
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(20_000);
  }, 30_000);

  it('records an await-based hang as timeout via the soft timeout (artifacts saved)', async () => {
    const dir = path.join(artifactsRoot, 'soft-timeout');
    await fs.mkdir(dir, { recursive: true });
    const outcome = await runInSandbox({
      specSource: [
        `await page.goto(${JSON.stringify(site.url)});`,
        `await new Promise(() => {}); // never settles`,
      ].join('\n'),
      timeoutMs: 5_000,
      artifactsDir: dir,
    });
    expect(outcome.status).toBe('timeout');
    expect(outcome.hardKilled).toBe(false);
    expect(outcome.screenshotSaved).toBe(true);
    expect(outcome.traceSaved).toBe(true);
  }, 30_000);

  it('gives the spec a clean env — DATABASE_URL & co are invisible', async () => {
    expect(process.env.DATABASE_URL).toBeTruthy(); // parent HAS it set
    const outcome = await runInSandbox({
      specSource: [
        `const leaked = ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'JWT_SECRET']`,
        `  .filter((k) => process.env[k] !== undefined);`,
        `if (leaked.length > 0) throw new Error('LEAKED: ' + leaked.join(','));`,
        `await page.goto('about:blank');`,
      ].join('\n'),
      timeoutMs: 30_000,
      artifactsDir: null,
    });
    expect(outcome.errorMessage ?? '').not.toContain('LEAKED');
    expect(outcome.status).toBe('passed');
  });

  it('classifies a navigation error as error', async () => {
    const outcome = await runInSandbox({
      specSource: `await page.goto('http://127.0.0.1:1/');`,
      timeoutMs: 15_000,
      artifactsDir: null,
    });
    expect(outcome.status).toBe('error');
    expect(outcome.errorMessage).toBeTruthy();
  });
});

describe('journey executor wrapper', () => {
  it('maps sandbox artifacts to relative run paths', async () => {
    const store = new ArtifactStore(artifactsRoot);
    const appId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const result = await executeJourney(
      {
        config: {
          specSource: [
            `await page.goto(${JSON.stringify(site.url)});`,
            `await expect(page.locator('#missing-element')).toBeVisible({ timeout: 1500 });`,
          ].join('\n'),
        },
        timeoutMs: 30_000,
      },
      { store, target: { appId, runId } },
    );
    expect(result.status).toBe('failed');
    expect(result.screenshotPath).toBe(path.join(appId, runId, SCREENSHOT_FILENAME));
    expect(result.tracePath).toBe(path.join(appId, runId, TRACE_FILENAME));
  });
});
