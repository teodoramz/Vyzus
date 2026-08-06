// Journey sandbox harness (02-architecture §5.2). Built to
// dist/sandbox/runner-harness.js and executed as a SEPARATE node child process
// by spawn.ts — never imported by the worker main process. It receives a JSON
// config path in argv[2], dynamically imports the user's spec module (written
// by spawn.ts to a temp file), runs it against a fresh traced context, and
// reports a single marked JSON line on stdout. On failure it saves a
// point-of-failure screenshot and trace.zip into the artifacts dir.
//
// Security: the parent passes a clean env (no platform secrets); this process
// runs as the container's non-root user and is hard-killed by the parent as a
// backstop for specs that block the event loop (e.g. while(true){}).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESULT_MARKER, type HarnessConfig, type HarnessResult } from './protocol.js';
import { newStealthContext } from '../browser-context.js';

interface SpecModule {
  default: (ctx: { page: unknown; context: unknown; expect: unknown }) => Promise<void>;
}

function emit(result: HarnessResult): void {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

/** Classify a thrown value: expect()/locator failures are 'failed', infra is 'error'. */
function classify(err: unknown): { status: 'failed' | 'error'; message: string } {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (err !== null && typeof err === 'object') {
    // Playwright expect() errors carry matcherResult; action/locator waits
    // throw TimeoutError — both mean "the site misbehaved", i.e. failed.
    const anyErr = err as { matcherResult?: unknown; name?: string };
    if (anyErr.matcherResult !== undefined || anyErr.name === 'TimeoutError') {
      return { status: 'failed', message };
    }
  }
  return { status: 'error', message };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    emit({
      status: 'error',
      durationMs: 0,
      errorMessage: 'harness: missing config path',
      screenshotSaved: false,
      traceSaved: false,
    });
    process.exit(1);
    return;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as HarnessConfig;
  const startedAt = Date.now();

  // Imported lazily so a broken install surfaces as a clean result line.
  const { chromium } = await import('playwright');
  const { expect } = await import('playwright/test');

  // VYZUS_CHROMIUM_EXECUTABLE (a browser path, not a secret — passed through
  // the clean-env allowlist in spawn.ts) lets hosts without the bundled download
  // use a system Chromium; unset keeps the Playwright image's bundled browser.
  const executablePath = process.env.VYZUS_CHROMIUM_EXECUTABLE;
  // Same anti-automation-detection launch flags as the main worker's shared
  // browser (see browser.ts) — a journey spec should see the same site a real
  // visitor would, not a bot-challenge page.
  const launchArgs = {
    headless: true as const,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  const browser = await chromium.launch(executablePath ? { ...launchArgs, executablePath } : launchArgs);
  const context = await newStealthContext(browser);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  let result: HarnessResult;

  // Soft timeout: catches await-based hangs while still letting us save
  // artifacts. Event-loop-blocking specs are SIGKILLed by the parent instead.
  const softTimeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`__VYZUS_TIMEOUT__ after ${config.timeoutMs} ms`)), config.timeoutMs);
    t.unref();
  });

  try {
    const specModule = (await import(pathToFileURL(config.specPath).href)) as SpecModule;
    if (typeof specModule.default !== 'function') {
      throw new Error('harness: spec module has no default export function');
    }
    await Promise.race([specModule.default({ page, context, expect }), softTimeout]);
    await context.tracing.stop(); // discard trace on success
    result = {
      status: 'passed',
      durationMs: Date.now() - startedAt,
      errorMessage: null,
      screenshotSaved: false,
      traceSaved: false,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('__VYZUS_TIMEOUT__');
    const { status, message } = isTimeout
      ? { status: 'timeout' as const, message: `Journey timed out after ${config.timeoutMs} ms` }
      : classify(err);

    let screenshotSaved = false;
    let traceSaved = false;
    if (config.artifactsDir) {
      try {
        // Viewport-only, not fullPage: shows what was actually visible (and
        // relevant) at the point of failure rather than the whole scrollable
        // page — also avoids an unwieldy multi-screen-tall image.
        await page.screenshot({
          path: path.join(config.artifactsDir, 'screenshot.png'),
          timeout: 5_000,
        });
        screenshotSaved = true;
      } catch {
        /* best effort */
      }
      try {
        await context.tracing.stop({ path: path.join(config.artifactsDir, 'trace.zip') });
        traceSaved = true;
      } catch {
        /* best effort */
      }
    } else {
      await context.tracing.stop().catch(() => undefined);
    }

    result = {
      status,
      durationMs: Date.now() - startedAt,
      errorMessage: message.slice(0, 4096),
      screenshotSaved,
      traceSaved,
    };
  }

  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  emit(result);
  process.exit(result.status === 'passed' ? 0 : 1);
}

main().catch((err) => {
  emit({
    status: 'error',
    durationMs: 0,
    errorMessage: `harness crashed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 4096),
    screenshotSaved: false,
    traceSaved: false,
  });
  process.exit(1);
});
