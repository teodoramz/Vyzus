// One shared Chromium instance per worker process; each run gets its own
// (cheap, isolated) browser context (02-architecture §4/§8).
import { chromium, type Browser, type LaunchOptions } from 'playwright';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

/**
 * Launch options for the shared Chromium. In the production Playwright image the
 * bundled browser is used; setting VYZUS_CHROMIUM_EXECUTABLE points Playwright
 * at a system browser instead (e.g. hosts where the bundled download is blocked).
 *
 * `--disable-blink-features=AutomationControlled` stops Chromium advertising
 * itself as automation-driven at the Blink level. Without it a monitored site
 * can serve a bot challenge instead of the real page, which then gets captured
 * as the check's screenshot — see browser-context.ts for the matching
 * navigator.webdriver patch.
 */
export function chromiumLaunchOptions(): LaunchOptions {
  const options: LaunchOptions = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    // Drops Playwright's own "--enable-automation" default, the flag that
    // makes Chrome report itself as automated.
    ignoreDefaultArgs: ['--enable-automation'],
  };
  const executablePath = process.env.VYZUS_CHROMIUM_EXECUTABLE;
  if (executablePath) options.executablePath = executablePath;
  return options;
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    launching = chromium.launch(chromiumLaunchOptions()).then((b) => {
      browser = b;
      launching = null;
      return b;
    });
  }
  return launching;
}

export async function closeBrowser(): Promise<void> {
  if (launching) await launching.catch(() => null);
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}
