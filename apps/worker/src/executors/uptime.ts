// Uptime executor (02-architecture §5.1).
import { errors as playwrightErrors, type BrowserContextOptions, type Page } from 'playwright';
import { evaluateCertExpiry, certExpiryMessage } from '@vyzus/shared';
import type { AppAuthConfig, HttpModeConfig, SessionLogin } from '@vyzus/shared';
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

/**
 * Drive a login form. Returns null on success, or an error message.
 *
 * Deliberately generic (three selectors + an optional proof) rather than
 * modelling any particular framework's login: the operator already knows their
 * own form, and a selector they can copy from devtools beats a scheme we guess.
 *
 * Secrets are typed into the page and never logged: the returned message
 * mentions selectors and URLs only.
 */
async function performSessionLogin(page: Page, login: SessionLogin, timeoutMs: number): Promise<string | null> {
  // A share of the total budget, so a hanging login cannot consume the whole
  // check timeout and leave nothing for the target itself.
  const budget = Math.max(5_000, Math.floor(timeoutMs / 2));
  try {
    await page.goto(login.loginUrl, { waitUntil: 'domcontentloaded', timeout: budget });
    await page.locator(login.usernameSelector).first().fill(login.username, { timeout: budget });
    await page.locator(login.passwordSelector).first().fill(login.password, { timeout: budget });

    // The submit usually navigates; waiting for the click and any resulting
    // load together avoids racing the redirect.
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: budget }).catch(() => undefined),
      page.locator(login.submitSelector).first().click({ timeout: budget }),
    ]);

    if (login.successSelector) {
      const ok = await page
        .locator(login.successSelector)
        .first()
        .waitFor({ state: 'visible', timeout: budget })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        return `Session login did not complete: "${login.successSelector}" never appeared after submitting ${login.loginUrl}`;
      }
    }
    return null;
  } catch (err) {
    const detail = err instanceof playwrightErrors.TimeoutError ? `timed out after ${budget} ms` : String(err);
    return truncateError(`Session login against ${login.loginUrl} failed — ${detail}`);
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
    // Session login, before the target is touched. Same browser context, so
    // the session cookie the form sets is carried straight into the check —
    // no storage-state serialisation, and nothing secret written to disk.
    //
    // A login failure ends the run here with its own message: letting it fall
    // through would fail the check's real assertions against a login page and
    // report something misleading like "selector not visible".
    if (authConfig?.sessionLogin) {
      const loginError = await performSessionLogin(page, authConfig.sessionLogin, timeoutMs);
      if (loginError) {
        return {
          status: 'failed',
          durationMs: Date.now() - startedAt,
          metrics: { sessionLogin: 'failed' },
          errorMessage: loginError,
          screenshotPath: null,
          tracePath: null,
        };
      }
    }

    let httpStatus: number | null = null;
    // Hoisted: the certificate check below reads it after the navigation block.
    let response: Awaited<ReturnType<Page['goto']>> = null;
    try {
      // `domcontentloaded`, not `load`: the HTTP status (the thing the check
      // actually asserts on) is known as soon as the response arrives, and a
      // heavy page whose last tracking pixel never finishes should not be
      // reported as a navigation timeout. Visual settling is handled by
      // settleForCapture() below, against its own budget.
      response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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

    // Certificate expiry, from the navigation Chromium already performed —
    // no second connection, and no separate TLS client to keep in step with
    // what the browser actually negotiated. Only an https:// target has one.
    //
    // A certificate that has already expired is too late to be useful: by then
    // the browser is refusing the site and the check has failed for a different
    // reason. The point is to fail while there is still time to renew.
    if (response && config.certExpiryWarningDays > 0 && status === 'passed') {
      const security = await response.securityDetails().catch(() => null);
      if (security?.validTo) {
        // Playwright reports these as Unix seconds.
        const validTo = new Date(security.validTo * 1000);
        const verdict = evaluateCertExpiry(validTo, config.certExpiryWarningDays);
        if (metrics) {
          metrics.certValidTo = validTo.toISOString();
          metrics.certIssuer = security.issuer ?? null;
          metrics.certSubject = security.subjectName ?? null;
          metrics.daysUntilExpiry = verdict.daysUntilExpiry;
          metrics.certExpiryWarningDays = config.certExpiryWarningDays;
        }
        if (verdict.expiringSoon) {
          status = 'failed';
          errorMessage = certExpiryMessage(
            new URL(landingUrl).host,
            verdict.daysUntilExpiry,
            validTo,
            config.certExpiryWarningDays,
          );
        }
      }
    }

    // Latency threshold. Measured here, before the screenshot: capturing one is
    // our own overhead, not the site's, and a threshold that fired because our
    // PNG encode was slow would be a false alarm. The value is recorded in
    // metrics so a failure can be reconciled against the number that caused it.
    const responseMs = Date.now() - startedAt;
    if (metrics) metrics.responseMs = responseMs;
    if (status === 'passed' && config.maxDurationMs > 0 && responseMs > config.maxDurationMs) {
      status = 'failed';
      errorMessage = `Responded in ${responseMs} ms, over the ${config.maxDurationMs} ms limit`;
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
