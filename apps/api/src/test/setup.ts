// Per-worker-process test setup. The full-stack smoke test launches a real
// worker (Playwright) in-process; point it at a system Chromium when the bundled
// browser isn't installed. Explicit env wins; else fall back to /usr/bin/chromium.
import { existsSync } from 'node:fs';

if (!process.env.VYZUS_CHROMIUM_EXECUTABLE) {
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) {
      process.env.VYZUS_CHROMIUM_EXECUTABLE = candidate;
      break;
    }
  }
}
