// Shared browser-context defaults for every check. Uses Playwright's Desktop
// Chrome device profile rather than Chromium's headless defaults, so monitored
// sites are not trivially able to flag the check as a bot.
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { devices } from 'playwright';

export const REALISTIC_CONTEXT_OPTIONS: BrowserContextOptions = {
  ...devices['Desktop Chrome'],
  locale: 'en-US',
  timezoneId: 'America/New_York',
};

// The device profile does not cover `navigator.webdriver`, which Playwright
// sets to true and bot-detection scripts check first. Defined on the prototype
// rather than the instance because `navigator.hasOwnProperty('webdriver')` is
// itself a common detection probe.
const HIDE_WEBDRIVER_SCRIPT = `
  Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
    get: () => false,
    configurable: true,
  });
`;

/** Use instead of `browser.newContext()` so every check gets the same
 * fingerprint defaults and the webdriver patch. */
export async function newStealthContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ ...REALISTIC_CONTEXT_OPTIONS, ...options });
  await context.addInitScript(HIDE_WEBDRIVER_SCRIPT);
  return context;
}
