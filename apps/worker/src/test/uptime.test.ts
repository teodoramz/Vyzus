// Uptime executor: metrics, assertions, screenshot modes, timeout classification.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { executeUptime } from '../executors/uptime.js';
import { closeBrowser } from '../browser.js';
import { ArtifactStore } from '../artifacts.js';
import { startTestSite, type TestSite } from './helpers.js';

let site: TestSite;
let artifactsRoot: string;

beforeAll(async () => {
  site = await startTestSite();
  artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-uptime-'));
});

afterAll(async () => {
  await site.close();
  await closeBrowser();
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

const base = { authConfig: null, timeoutMs: 10_000, captureScreenshot: () => false };

describe('uptime executor', () => {
  it('passes with metrics on a healthy target', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, screenshot: 'never' },
    });
    expect(result.status).toBe('passed');
    expect(result.errorMessage).toBeNull();
    expect(result.metrics).toMatchObject({ httpStatus: 200 });
    expect(typeof (result.metrics as Record<string, unknown>).ttfbMs).toBe('number');
    expect(typeof (result.metrics as Record<string, unknown>).loadMs).toBe('number');
    expect(result.screenshotPath).toBeNull();
  });

  // Regression guard: a monitored site that flags the check as a bot can serve
  // a challenge page instead of the real one, which then gets captured as the
  // check's screenshot. Asserts the fingerprint the *server and page* actually
  // observe, not just the options we passed to newContext.
  it('presents a normal browser fingerprint (real UA, navigator.webdriver false)', async () => {
    const result = await executeUptime({
      ...base,
      landingUrl: `${site.url}echo-ua`,
      // The page writes String(navigator.webdriver) into the body; asserting
      // bodyText 'false' means the *page* saw the automation flag hidden.
      config: { mode: 'http', expectedStatus: 200, bodyText: 'false', screenshot: 'never' },
    });
    expect(result.status).toBe('passed');

    // And assert what the server actually received on the wire.
    const headers = site.lastRequestHeaders();
    const ua = String(headers?.['user-agent'] ?? '');
    expect(ua).toContain('Chrome/');
    expect(ua).toContain('Mozilla/5.0');
    expect(ua).not.toContain('HeadlessChrome');
    expect(String(headers?.['accept-language'] ?? '')).toContain('en-US');
  });

  it('asserts selector and body text', async () => {
    const ok = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, selector: '#hero', bodyText: 'demo shop', screenshot: 'never' },
    });
    expect(ok.status).toBe('passed');

    const badSelector = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, selector: '#does-not-exist', screenshot: 'never' },
    });
    expect(badSelector.status).toBe('failed');
    expect(badSelector.errorMessage).toContain('#does-not-exist');

    const badText = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, bodyText: 'NOT ON THE PAGE', screenshot: 'never' },
    });
    expect(badText.status).toBe('failed');
  });

  it('asserts the page title', async () => {
    const ok = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, title: 'Test Site', screenshot: 'never' },
    });
    expect(ok.status).toBe('passed');

    const bad = await executeUptime({
      ...base,
      landingUrl: site.url,
      config: { mode: 'http', expectedStatus: 200, title: 'Not The Title', screenshot: 'never' },
    });
    expect(bad.status).toBe('failed');
    expect(bad.errorMessage).toContain('Not The Title');
    expect(bad.errorMessage).toContain('Test Site');
  });

  it('fails on unexpected HTTP status and captures an on_failure screenshot', async () => {
    site.setDown(true);
    try {
      const store = new ArtifactStore(artifactsRoot);
      const appId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const result = await executeUptime(
        {
          ...base,
          landingUrl: site.url,
          config: { mode: 'http', expectedStatus: 200, screenshot: 'on_failure' },
          captureScreenshot: (status: string) => status !== 'passed',
        },
        { store, target: { appId, runId } },
      );
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('Expected HTTP 200, got 503');
      expect(result.screenshotPath).toBe(path.join(appId, runId, 'screenshot.png'));
      const stat = await fs.stat(store.absolutePath(result.screenshotPath!));
      expect(stat.size).toBeGreaterThan(500);
    } finally {
      site.setDown(false);
    }
  });

  it('records a navigation timeout as timeout', async () => {
    const result = await executeUptime({
      ...base,
      timeoutMs: 3_000,
      landingUrl: `${site.url}slow`,
      config: { mode: 'http', expectedStatus: 200, screenshot: 'never' },
    });
    expect(result.status).toBe('timeout');
    expect(result.errorMessage).toContain('timed out');
  }, 30_000);

  it('takes a screenshot when mode is always (screenshot-now path)', async () => {
    const store = new ArtifactStore(artifactsRoot);
    const appId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const result = await executeUptime(
      {
        ...base,
        landingUrl: site.url,
        config: { mode: 'http', expectedStatus: 200, screenshot: 'always' },
        captureScreenshot: () => true,
      },
      { store, target: { appId, runId } },
    );
    expect(result.status).toBe('passed');
    expect(result.screenshotPath).not.toBeNull();
  });
});
