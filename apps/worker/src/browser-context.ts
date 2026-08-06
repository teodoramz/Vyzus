// Shared "look like a normal user" context defaults for every check (uptime and
// journey/sandbox). Uses Playwright's own Desktop Chrome device fingerprint —
// real UA/viewport/screen — instead of Chromium's bare headless defaults, so
// checks aren't trivially flagged as bots by the sites they monitor.
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { devices } from 'playwright';

export const REALISTIC_CONTEXT_OPTIONS: BrowserContextOptions = {
  ...devices['Desktop Chrome'],
  locale: 'en-US',
  timezoneId: 'America/New_York',
};

// The UA/viewport/locale spoofing above doesn't touch the single most common
// automation tell: real, non-automated Chrome reports
// `navigator.webdriver === false`; Playwright's CDP session flips it to
// `true` regardless of what the context options claim, and it's the first
// thing most bot-detection scripts (Cloudflare, DataDome, reCAPTCHA, etc.)
// check — a site that would otherwise render normally can instead serve a
// challenge/CAPTCHA page, which is exactly what a captured screenshot would
// show. Patched on the *prototype* (not as an own property on the instance)
// so it reads as a native getter rather than an injected override, since
// `navigator.hasOwnProperty('webdriver')` is itself a check some scripts run.
const HIDE_WEBDRIVER_SCRIPT = `
  Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
    get: () => false,
    configurable: true,
  });
`;

/** Same as `browser.newContext(REALISTIC_CONTEXT_OPTIONS)`, plus the
 * navigator.webdriver patch every check should get — use this instead of
 * calling newContext directly. */
export async function newStealthContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ ...REALISTIC_CONTEXT_OPTIONS, ...options });
  await context.addInitScript(HIDE_WEBDRIVER_SCRIPT);
  return context;
}
