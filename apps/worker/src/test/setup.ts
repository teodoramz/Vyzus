// Per-worker-process test setup. Point Playwright at a system Chromium when the
// bundled browser isn't installed (hosts where the download is blocked). Runs in
// every vitest worker, so both the in-process browser (browser.ts) and the
// sandbox child (spawn.ts forwards this var through its clean-env allowlist)
// pick it up. Explicit env wins; otherwise fall back to /usr/bin/chromium.
import { existsSync } from 'node:fs';

if (!process.env.VYZUS_CHROMIUM_EXECUTABLE) {
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) {
      process.env.VYZUS_CHROMIUM_EXECUTABLE = candidate;
      break;
    }
  }
}
