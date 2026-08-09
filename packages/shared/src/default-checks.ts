// The starter set of checks created with a new application.
//
// The goal is that a freshly enrolled site is meaningfully monitored without
// anyone opening the check editor — but every default must be one that *passes*
// on day one for a healthy target. A default that cries wolf immediately is
// worse than no default: people learn to ignore the badge, and the first real
// failure looks like more of the same noise.
//
// Pure, and shared, so the dashboard, the REST API and scripts/sync-targets all
// produce the same set.
import {
  DEFAULT_SCREENSHOT_REFRESH_MINUTES,
  DEFAULT_DNS_CHECK_INTERVAL_MINUTES,
  DEFAULT_CERT_CHECK_INTERVAL_MINUTES,
  DEFAULT_CERT_EXPIRY_WARNING_DAYS,
} from './constants.js';
import type { CheckType } from './constants.js';
import type { UptimeConfig } from './schemas/checks.js';

export interface DefaultCheckSpec {
  type: CheckType;
  name: string;
  intervalMinutes: number;
  config: UptimeConfig;
}

/** IPv4 dotted quad or anything containing a colon (IPv6). Browser-safe — no node:net. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * @param landingUrl the application's landing URL
 * @param intervalMinutes cadence for the primary uptime check
 */
export function defaultChecksFor(landingUrl: string, intervalMinutes: number): DefaultCheckSpec[] {
  const specs: DefaultCheckSpec[] = [
    {
      type: 'uptime',
      name: 'Landing uptime',
      intervalMinutes,
      config: {
        mode: 'http',
        expectedStatus: 200,
        screenshot: 'on_change',
        screenshotRefreshMinutes: DEFAULT_SCREENSHOT_REFRESH_MINUTES,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
      },
    },
  ];

  let url: URL;
  try {
    url = new URL(landingUrl);
  } catch {
    // Not parseable: the uptime check alone is all we can honestly derive.
    return specs;
  }
  const host = url.hostname;

  // DNS: catches the expired domain or botched record that an HTTP check run
  // from a machine with a warm cache cannot see. Skipped for an IP literal,
  // where there is no name to resolve. Slow cadence — records rarely move, and
  // there is no reason to query every minute.
  if (!isIpLiteral(host)) {
    specs.push({
      type: 'uptime',
      name: 'DNS resolves',
      intervalMinutes: DEFAULT_DNS_CHECK_INTERVAL_MINUTES,
      config: { mode: 'dns', host, recordType: 'A', expectedValues: [] },
    });
  }

  // Certificate expiry: consistently a top cause of self-inflicted outages, and
  // invisible until the day browsers start refusing the site. Only for https,
  // and hourly — an expiry date does not change minute to minute.
  if (url.protocol === 'https:') {
    specs.push({
      type: 'uptime',
      name: 'TLS certificate',
      intervalMinutes: DEFAULT_CERT_CHECK_INTERVAL_MINUTES,
      config: {
        mode: 'port',
        host,
        port: url.port ? Number(url.port) : 443,
        protocol: 'tcp',
        family: 'auto',
        tls: true,
        // Chain trust is deliberately NOT enforced here, and that costs nothing:
        // the landing uptime check loads the site in Chromium, which refuses an
        // untrusted certificate outright, so a broken chain on a public site
        // already fails that check. Enforcing it again here would add no signal
        // and would false-alarm on every deliberately self-signed internal
        // service — breaking the rule that a default must pass on day one.
        //
        // The expiry warning below is unaffected by this flag: a self-signed
        // certificate expires exactly like a public one, and catching that is
        // the whole reason this check exists. Turn the flag off per-check to
        // additionally enforce the chain.
        allowInsecureCert: true,
        certExpiryWarningDays: DEFAULT_CERT_EXPIRY_WARNING_DAYS,
      },
    });
  }

  // Deliberately NOT included: an ICMP ping check. ICMP is blocked by most
  // CDNs and many cloud providers, so a default ping would report a perfectly
  // healthy site as unreachable — and since `ping` is a liveness mode, it would
  // drag the application badge down on the day it was added. Add one by hand
  // where you know ICMP is answered.

  return specs;
}
