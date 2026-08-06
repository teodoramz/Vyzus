// Uptime executor (02-architecture §5.1).
import { errors as playwrightErrors, type BrowserContextOptions, type Page } from 'playwright';
import type { AppAuthConfig, HttpModeConfig } from '@vyzus/shared';
import { getBrowser } from '../browser.js';
import { newStealthContext } from '../browser-context.js';
import type { ArtifactStore } from '../artifacts.js';
import { truncateError, type ArtifactTarget, type ExecutionResult } from './types.js';

export interface UptimeInput {
  landingUrl: string;
  authConfig: AppAuthConfig | null;
  config: HttpModeConfig;
  timeoutMs: number;
  /**
   * Decided by the caller, since the policy needs check state the executor
   * does not have. Invoked once the outcome is known and the page is still
   * open, so the outcome can inform the decision without a second navigation.
   */
  captureScreenshot: (status: ExecutionResult['status']) => boolean;
}

interface NavTimings {
  ttfbMs: number;
  dclMs: number;
  loadMs: number;
}

/**
 * Wait for the page to be visually settled before capturing.
 *
 * `load` fires before a client-rendered app paints, so a screenshot taken
 * there catches an empty root element; `networkidle` as the *navigation*
 * condition never settles on sites with polling or websockets. Hence a cheap
 * navigation plus a bounded grace period here. All waits are best-effort.
 */
async function settleForCapture(page: Page, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  await page.waitForLoadState('load', { timeout: budgetMs }).catch(() => undefined);
  const remaining = deadline - Date.now();
  if (remaining > 250) {
    await page.waitForLoadState('networkidle', { timeout: remaining }).catch(() => undefined);
  }
  // Final short beat so any paint triggered by the last network response
  // actually lands before the capture.
  await page.waitForTimeout(Math.min(400, Math.max(0, deadline - Date.now()))).catch(() => undefined);
}

async function collectTimings(page: Page): Promise<NavTimings | null> {
  try {
    return await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return null;
      return {
        ttfbMs: Math.round(nav.responseStart),
        dclMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
      };
    });
  } catch {
    return null;
  }
}

export async function executeUptime(
  input: UptimeInput,
  artifacts?: { store: ArtifactStore; target: ArtifactTarget },
): Promise<ExecutionResult> {
  const { landingUrl, authConfig, config, timeoutMs, captureScreenshot } = input;
  const startedAt = Date.now();

  const contextOptions: BrowserContextOptions = {
    ...(authConfig?.basicAuth ? { httpCredentials: authConfig.basicAuth } : {}),
    ...(authConfig?.headers ? { extraHTTPHeaders: authConfig.headers } : {}),
  };

  const browser = await getBrowser();
  const context = await newStealthContext(browser, contextOptions);
  const page = await context.newPage();

  let status: ExecutionResult['status'] = 'passed';
  let errorMessage: string | null = null;
  let metrics: Record<string, unknown> | null = null;

  try {
    let httpStatus: number | null = null;
    try {
      // `domcontentloaded`, not `load`: the HTTP status (the thing the check
      // actually asserts on) is known as soon as the response arrives, and a
      // heavy page whose last tracking pixel never finishes should not be
      // reported as a navigation timeout. Visual settling is handled by
      // settleForCapture() below, against its own budget.
      const response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      httpStatus = response?.status() ?? null;
      // Bounded settle: at most half the check's timeout, capped at 10s, so a
      // slow-but-alive page still gets a usable screenshot without letting a
      // never-idle page consume the whole budget.
      await settleForCapture(page, Math.min(10_000, Math.max(1_000, Math.floor(timeoutMs / 2))));
    } catch (err) {
      if (err instanceof playwrightErrors.TimeoutError) {
        status = 'timeout';
        errorMessage = `Navigation timed out after ${timeoutMs} ms`;
      } else {
        status = 'error';
        errorMessage = truncateError(err instanceof Error ? err.message : String(err));
      }
    }

    if (status === 'passed') {
      const timings = await collectTimings(page);
      metrics = { httpStatus, ...(timings ?? {}) };

      // Assertions (failed = assertion, error = infra — per 03-data-model).
      if (httpStatus !== config.expectedStatus) {
        status = 'failed';
        errorMessage = `Expected HTTP ${config.expectedStatus}, got ${httpStatus ?? 'no response'}`;
      } else if (config.selector) {
        const visible = await page
          .locator(config.selector)
          .first()
          .isVisible()
          .catch(() => false);
        if (!visible) {
          status = 'failed';
          errorMessage = `Selector not visible: ${config.selector}`;
        }
      }
      if (status === 'passed' && config.bodyText) {
        const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (!body.includes(config.bodyText)) {
          status = 'failed';
          errorMessage = `Body does not contain text: "${config.bodyText}"`;
        }
      }
      if (status === 'passed' && config.title) {
        const pageTitle = await page.title().catch(() => '');
        if (!pageTitle.includes(config.title)) {
          status = 'failed';
          errorMessage = `Title does not contain: "${config.title}" (got "${pageTitle}")`;
        }
      }
    } else if (httpStatus != null) {
      metrics = { httpStatus };
    }

    // Screenshot per the caller's decision; best-effort on error/timeout pages too.
    let screenshotPath: string | null = null;
    if (artifacts && captureScreenshot(status)) {
      try {
        // On a failed/timed-out navigation the page may still be mid-load, so
        // give it a brief chance to render an error page rather than
        // capturing a blank frame.
        if (status !== 'passed') await settleForCapture(page, 3_000);
        // Viewport-only (not fullPage): a long scrolling landing page produces
        // a full-page capture many times taller than wide, which is unwieldy
        // to review — this captures what a real visitor sees above the fold.
        // `animations: 'disabled'` freezes CSS animations/transitions so a
        // spinner or fade-in doesn't get captured mid-frame.
        const png = await page.screenshot({ timeout: 10_000, animations: 'disabled' });
        screenshotPath = await artifacts.store.writeScreenshot(artifacts.target.appId, artifacts.target.runId, png);
      } catch {
        // never fail a run because the screenshot failed
      }
    }

    return {
      status,
      durationMs: Date.now() - startedAt,
      metrics,
      errorMessage,
      screenshotPath,
      tracePath: null,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
