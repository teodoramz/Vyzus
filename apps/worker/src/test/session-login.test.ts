// Session login: any target behind a normal login form renders as a login page
// to the checker, and the screenshot captures nothing useful. These tests run a
// real Chromium against a real cookie-session server — the whole point is that
// the session survives from the login form into the check itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeUptime } from '../executors/uptime.js';
import { closeBrowser } from '../browser.js';
import { startTestSite, type TestSite } from './helpers.js';

let site: TestSite;

beforeAll(async () => {
  site = await startTestSite();
});

afterAll(async () => {
  await site.close();
  await closeBrowser();
});

const base = { timeoutMs: 20_000, captureScreenshot: () => false };
const httpConfig = (over: Record<string, unknown> = {}) => ({
  mode: 'http' as const,
  expectedStatus: 200,
  maxDurationMs: 0,
  visualDiffPercent: 0,
  screenshot: 'never' as const,
  ...over,
});

function login(over: Record<string, unknown> = {}) {
  return {
    loginUrl: `${site.url}login`,
    usernameSelector: '#u',
    passwordSelector: '#p',
    submitSelector: '#go',
    username: 'demo',
    password: 'hunter2',
    ...over,
  };
}

describe('session login', () => {
  // Establishes that the target really is protected, so the passing test below
  // proves the login did something rather than the page being public anyway.
  it('sees the login page when no credentials are configured', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: null,
      config: httpConfig({ selector: '#welcome' }),
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/Selector not visible/);
  });

  it('carries the session from the login form into the check', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: { sessionLogin: login() },
      config: httpConfig({ selector: '#welcome', bodyText: 'Signed in' }),
    });
    expect(result.status).toBe('passed');
    expect(result.errorMessage).toBeNull();
  });

  // Without successSelector a bad password fails later, on the check's own
  // assertions, with a message that points at the wrong thing.
  it('reports a wrong password as a login failure, not a check failure', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: { sessionLogin: login({ password: 'wrong', successSelector: '#welcome' }) },
      config: httpConfig({ selector: '#welcome' }),
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/Session login did not complete/);
    expect((result.metrics as Record<string, unknown>).sessionLogin).toBe('failed');
  });

  it('reports a selector that does not exist as a login failure', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: { sessionLogin: login({ usernameSelector: '#nope' }) },
      config: httpConfig(),
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/Session login against .* failed/);
  });

  // The password must never reach a run's error message, which is stored and
  // shipped to alert channels.
  it('never leaks the password into the error message', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: { sessionLogin: login({ password: 'sup3rs3cret', successSelector: '#nope' }) },
      config: httpConfig(),
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).not.toContain('sup3rs3cret');
    expect(JSON.stringify(result.metrics)).not.toContain('sup3rs3cret');
  });

  it('still works alongside basic auth and custom headers being absent', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}secret`,
      authConfig: { sessionLogin: login({ successSelector: '#welcome' }) },
      config: httpConfig({ title: 'Dashboard' }),
    });
    expect(result.status).toBe('passed');
  });
});
