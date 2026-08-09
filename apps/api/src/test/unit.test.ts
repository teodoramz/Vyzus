import { describe, expect, it } from 'vitest';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { TokenService } from '../lib/tokens.js';
import { deriveAppStatus } from '../lib/queries.js';
import { loadConfig } from '../config.js';
import {
  evaluateHeartbeat,
  activeMaintenanceWindow,
  dueForRenotify,
  evaluateCertExpiry,
  certExpiryMessage,
  findFailingAncestor,
  wouldCreateCycle,
  defaultChecksFor,
} from '@vyzus/shared';
import type { CheckRow } from '../db/schema.js';

/** Only the fields deriveAppStatus reads; the rest are irrelevant to the pure function. */
function check(overrides: Partial<CheckRow>): CheckRow {
  return {
    id: 'c1',
    appId: 'a1',
    type: 'uptime',
    name: 'x',
    intervalMinutes: 5,
    timeoutMs: 30000,
    failureThreshold: 2,
    enabled: true,
    config: { expectedStatus: 200, screenshot: 'never' },
    consecutiveFailures: 0,
    lastStatus: null,
    lastRunAt: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CheckRow;
}

describe('deriveAppStatus', () => {
  it('is UNKNOWN when the app has no checks at all', () => {
    expect(deriveAppStatus(true, [])).toBe('UNKNOWN');
  });

  it('is UP when everything that has run is passing', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'passed' }),
      check({ id: 'j1', type: 'journey', lastStatus: 'passed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('UP');
  });

  it('is DOWN only when every liveness check is failing', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'failed' }),
      check({ id: 'u2', type: 'uptime', lastStatus: 'timeout' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DOWN');
  });

  it('is DEGRADED — not DOWN — when only some liveness checks are failing', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'passed' }),
      check({ id: 'u2', type: 'uptime', lastStatus: 'failed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DEGRADED');
  });

  it('a failing journey degrades the app but never marks it down', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'passed' }),
      check({ id: 'j1', type: 'journey', lastStatus: 'failed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DEGRADED');

    // Journey-only app: still never DOWN, however broken the flow is.
    expect(deriveAppStatus(true, [check({ type: 'journey', lastStatus: 'failed' })])).toBe('DEGRADED');
  });

  it('a single failing liveness check is DOWN when it is the only one', () => {
    expect(deriveAppStatus(true, [check({ type: 'uptime', lastStatus: 'failed' })])).toBe('DOWN');
  });

  it('a down app stays DOWN even while a journey happens to pass', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'failed' }),
      check({ id: 'j1', type: 'journey', lastStatus: 'passed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DOWN');
  });

  it('ignores checks that have never run when judging DOWN', () => {
    // u2 has no result yet, so "all liveness failing" is judged on u1 alone.
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'failed' }),
      check({ id: 'u2', type: 'uptime', lastStatus: null }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DOWN');
  });

  it('is PAUSED when the app is disabled or every check is disabled', () => {
    expect(deriveAppStatus(false, [check({ lastStatus: 'passed' })])).toBe('PAUSED');
    expect(deriveAppStatus(true, [check({ enabled: false, lastStatus: 'passed' })])).toBe('PAUSED');
  });

  it('is UNKNOWN when the only enabled check has never run', () => {
    expect(deriveAppStatus(true, [check({ lastStatus: null })])).toBe('UNKNOWN');
  });
});

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('loadConfig — isSecureOrigin', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    REDIS_URL: 'redis://x',
    JWT_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: KEY,
  };

  it('is false over plain HTTP, so the refresh cookie is not marked Secure', () => {
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://vyzus.internal:8080' }).isSecureOrigin).toBe(false);
  });

  it('is true over HTTPS regardless of port', () => {
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://vyzus.internal:8443' }).isSecureOrigin).toBe(true);
  });

  // The old behaviour keyed this off NODE_ENV, which marked the cookie Secure
  // on plain-HTTP production deployments — where browsers discard it.
  it('ignores NODE_ENV', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'http://vyzus.internal' }).isSecureOrigin).toBe(
      false,
    );
    expect(loadConfig({ ...base, NODE_ENV: 'development', PUBLIC_URL: 'https://vyzus.internal' }).isSecureOrigin).toBe(
      true,
    );
  });
});

describe('AES-256-GCM helper', () => {
  it('round-trips a value', () => {
    const value = { basicAuth: { username: 'u', password: 'p' }, headers: { 'x-a': 'b' } };
    const blob = encryptJson(value, KEY);
    expect(blob.split('.')).toHaveLength(3);
    expect(blob).not.toContain('password');
    expect(decryptJson(blob, KEY)).toEqual(value);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const blob = encryptJson({ a: 1 }, KEY);
    const [iv, tag] = blob.split('.');
    const tampered = [iv, tag, Buffer.from('AAAA', 'utf8').toString('base64')].join('.');
    expect(() => decryptJson(tampered, KEY)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptJson({ a: 1 }, KEY);
    const otherKey = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
    expect(() => decryptJson(blob, otherKey)).toThrow();
  });
});

describe('TokenService', () => {
  it('issues and verifies an access token', async () => {
    const tokens = new TokenService('secret-secret-secret-1234', '15m', 7);
    const token = await tokens.signAccessToken({ sub: 'u1', role: 'admin', email: 'a@b.c' });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims).toEqual({ sub: 'u1', role: 'admin', email: 'a@b.c' });
  });

  it('produces distinct refresh tokens with matching hashes', async () => {
    const tokens = new TokenService('secret-secret-secret-1234', '15m', 7);
    const a = await tokens.issueRefreshToken('u1');
    const b = await tokens.issueRefreshToken('u1');
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
    const claims = await tokens.verifyRefreshToken(a.token);
    expect(claims.sub).toBe('u1');
  });
});

describe("evaluateHeartbeat — dead-man's switch", () => {
  const base = {
    now: new Date('2026-08-07T12:00:00Z'),
    since: new Date('2026-08-07T00:00:00Z'),
    enabledChecks: 3,
    shortestIntervalMinutes: 5,
    stallMinutes: 15,
  };

  it('is quiet while runs keep arriving', () => {
    const v = evaluateHeartbeat({ ...base, lastRunAt: new Date('2026-08-07T11:58:00Z') });
    expect(v.stalled).toBe(false);
    expect(v.silentForSeconds).toBe(120);
  });

  it('stalls once silence passes the threshold', () => {
    const v = evaluateHeartbeat({ ...base, lastRunAt: new Date('2026-08-07T11:40:00Z') });
    expect(v.stalled).toBe(true);
    expect(v.effectiveThresholdMinutes).toBe(15);
  });

  it('is off when stallMinutes is 0, however long the silence', () => {
    const v = evaluateHeartbeat({
      ...base,
      stallMinutes: 0,
      lastRunAt: new Date('2026-08-01T00:00:00Z'),
    });
    expect(v.stalled).toBe(false);
  });

  it('never stalls when nothing is enabled — silence is then correct', () => {
    const v = evaluateHeartbeat({
      ...base,
      enabledChecks: 0,
      shortestIntervalMinutes: null,
      lastRunAt: new Date('2026-08-01T00:00:00Z'),
    });
    expect(v.stalled).toBe(false);
  });

  // The guard that stops an hourly-only deployment alerting every 15 minutes.
  it('raises the threshold to twice the shortest interval when that is longer', () => {
    const v = evaluateHeartbeat({
      ...base,
      shortestIntervalMinutes: 60,
      lastRunAt: new Date('2026-08-07T11:00:00Z'), // 60m of silence
    });
    expect(v.effectiveThresholdMinutes).toBe(120);
    expect(v.stalled).toBe(false);
  });

  it('still stalls an hourly check once past twice its interval', () => {
    const v = evaluateHeartbeat({
      ...base,
      shortestIntervalMinutes: 60,
      lastRunAt: new Date('2026-08-07T09:30:00Z'), // 150m of silence
    });
    expect(v.stalled).toBe(true);
  });

  // A fresh deployment has no runs at all; measuring from the epoch would
  // declare it stalled the moment the first check is created.
  it('measures from `since` when nothing has ever run', () => {
    const v = evaluateHeartbeat({
      ...base,
      lastRunAt: null,
      since: new Date('2026-08-07T11:55:00Z'),
    });
    expect(v.silentForSeconds).toBe(300);
    expect(v.stalled).toBe(false);
  });

  it('stalls a deployment whose first check never ran at all', () => {
    const v = evaluateHeartbeat({
      ...base,
      lastRunAt: null,
      since: new Date('2026-08-07T10:00:00Z'),
    });
    expect(v.stalled).toBe(true);
  });
});

describe('activeMaintenanceWindow', () => {
  const APP = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const w = (appId: string | null, from: string, to: string) => ({
    appId,
    startsAt: new Date(from),
    endsAt: new Date(to),
    reason: 'deploy',
  });
  const at = (t: string) => new Date(t);

  it('matches a window scoped to the application', () => {
    const windows = [w(APP, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z')];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T01:30:00Z'))).not.toBeNull();
  });

  it('ignores a window scoped to a different application', () => {
    const windows = [w(OTHER, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z')];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T01:30:00Z'))).toBeNull();
  });

  it('a platform-wide window (null appId) covers every application', () => {
    const windows = [w(null, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z')];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T01:30:00Z'))).not.toBeNull();
    expect(activeMaintenanceWindow(windows, OTHER, at('2026-08-07T01:30:00Z'))).not.toBeNull();
  });

  it('is half-open: start is inside, end is not', () => {
    const windows = [w(APP, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z')];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T01:00:00Z'))).not.toBeNull();
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T02:00:00Z'))).toBeNull();
  });

  // Back-to-back windows must leave no unsuppressed instant between them.
  it('leaves no gap between adjacent windows', () => {
    const windows = [
      w(APP, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z'),
      w(APP, '2026-08-07T02:00:00Z', '2026-08-07T03:00:00Z'),
    ];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T02:00:00Z'))).not.toBeNull();
  });

  it('is null outside every window', () => {
    const windows = [w(APP, '2026-08-07T01:00:00Z', '2026-08-07T02:00:00Z')];
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T00:59:59Z'))).toBeNull();
    expect(activeMaintenanceWindow(windows, APP, at('2026-08-07T03:00:00Z'))).toBeNull();
  });
});

describe('dueForRenotify', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const at = (iso: string) => new Date(iso);
  const inc = (id: string, openedAt: string, lastNotifiedAt: string | null) => ({
    incidentId: id,
    openedAt: at(openedAt),
    lastNotifiedAt: lastNotifiedAt ? at(lastNotifiedAt) : null,
  });

  it('is off when the cadence is 0, however old the incident', () => {
    const out = dueForRenotify({
      now,
      renotifyMinutes: 0,
      candidates: [inc('a', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')],
    });
    expect(out).toEqual([]);
  });

  it('picks incidents whose last notification is older than the cadence', () => {
    const out = dueForRenotify({
      now,
      renotifyMinutes: 30,
      candidates: [
        inc('due', '2026-08-08T10:00:00Z', '2026-08-08T11:00:00Z'), // 60m ago
        inc('recent', '2026-08-08T10:00:00Z', '2026-08-08T11:50:00Z'), // 10m ago
      ],
    });
    expect(out.map((c) => c.incidentId)).toEqual(['due']);
  });

  it('is inclusive at exactly the cadence boundary', () => {
    const out = dueForRenotify({
      now,
      renotifyMinutes: 30,
      candidates: [inc('a', '2026-08-08T10:00:00Z', '2026-08-08T11:30:00Z')],
    });
    expect(out).toHaveLength(1);
  });

  // Measured from the last notification, not from openedAt — otherwise an
  // incident whose first alert was delayed would fire a burst of catch-up
  // reminders the moment the cadence was enabled.
  it('measures from the last notification, not from when it opened', () => {
    const out = dueForRenotify({
      now,
      renotifyMinutes: 30,
      candidates: [inc('a', '2026-08-01T00:00:00Z', '2026-08-08T11:55:00Z')],
    });
    expect(out).toEqual([]);
  });

  // Rows predating the column have no notification timestamp.
  it('falls back to openedAt when nothing has been notified yet', () => {
    const out = dueForRenotify({
      now,
      renotifyMinutes: 30,
      candidates: [inc('old', '2026-08-08T10:00:00Z', null), inc('fresh', '2026-08-08T11:55:00Z', null)],
    });
    expect(out.map((c) => c.incidentId)).toEqual(['old']);
  });
});

describe('evaluateCertExpiry', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

  it('is off when no threshold is set, however close the expiry', () => {
    expect(evaluateCertExpiry(inDays(1), 0, now).expiringSoon).toBe(false);
  });

  it('warns inside the window and stays quiet outside it', () => {
    expect(evaluateCertExpiry(inDays(5), 14, now).expiringSoon).toBe(true);
    expect(evaluateCertExpiry(inDays(30), 14, now).expiringSoon).toBe(false);
  });

  it('is inclusive at exactly the threshold', () => {
    expect(evaluateCertExpiry(inDays(14), 14, now).expiringSoon).toBe(true);
  });

  // Floor, not round: 13.6 days left is 13 usable days. Rounding to 14 would
  // let it slip past a 14-day threshold unnoticed.
  it('floors partial days rather than rounding', () => {
    const v = evaluateCertExpiry(new Date(now.getTime() + 13.6 * 86_400_000), 14, now);
    expect(v.daysUntilExpiry).toBe(13);
    expect(v.expiringSoon).toBe(true);
  });

  it('reports an already-expired certificate as negative days', () => {
    const v = evaluateCertExpiry(inDays(-3), 14, now);
    expect(v.daysUntilExpiry).toBe(-3);
    expect(v.expiringSoon).toBe(true);
  });

  it('phrases the message for expired, today, and upcoming', () => {
    expect(certExpiryMessage('example.com', -3, inDays(-3), 14)).toMatch(/expired 3 day\(s\) ago/);
    expect(certExpiryMessage('example.com', 0, inDays(0), 14)).toMatch(/expires today/);
    expect(certExpiryMessage('example.com:443', 5, inDays(5), 14)).toMatch(
      /example\.com:443 expires in 5 day\(s\).*threshold is 14/,
    );
  });
});

describe('application dependencies', () => {
  const node = (id: string, parentAppId: string | null, status: string) => ({ id, parentAppId, name: id, status });
  const map = (...ns: ReturnType<typeof node>[]) => new Map(ns.map((n) => [n.id, n]));

  it('finds no ancestor when there is no parent', () => {
    expect(findFailingAncestor('a', map(node('a', null, 'DOWN')))).toBeNull();
  });

  it('finds a failing immediate parent', () => {
    const m = map(node('child', 'gw', 'DOWN'), node('gw', null, 'DOWN'));
    expect(findFailingAncestor('child', m)?.id).toBe('gw');
  });

  // A dead host makes a service two levels down just as much collateral.
  it('walks past a healthy parent to a failing grandparent', () => {
    const m = map(node('svc', 'gw', 'DOWN'), node('gw', 'host', 'UP'), node('host', null, 'DOWN'));
    expect(findFailingAncestor('svc', m)?.id).toBe('host');
  });

  it('returns null when every ancestor is healthy', () => {
    const m = map(node('svc', 'gw', 'DOWN'), node('gw', 'host', 'UP'), node('host', null, 'UP'));
    expect(findFailingAncestor('svc', m)).toBeNull();
  });

  // A partly-working upstream can still leave this service genuinely broken.
  it('does not suppress on a merely DEGRADED ancestor', () => {
    const m = map(node('svc', 'gw', 'DOWN'), node('gw', null, 'DEGRADED'));
    expect(findFailingAncestor('svc', m)).toBeNull();
  });

  it('terminates on a cycle instead of hanging', () => {
    const m = map(node('a', 'b', 'UP'), node('b', 'a', 'UP'));
    expect(findFailingAncestor('a', m)).toBeNull();
  });

  it('rejects a parent that would create a cycle', () => {
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    // a -> b -> c already; making a a child of c closes the loop.
    expect(wouldCreateCycle('a', 'c', parentOf)).toBe(true);
    expect(wouldCreateCycle('a', 'a', parentOf)).toBe(true);
    expect(wouldCreateCycle('c', null, parentOf)).toBe(false);
    // A fresh leaf under an existing chain is fine.
    expect(wouldCreateCycle('d', 'c', parentOf)).toBe(false);
  });
});

describe('defaultChecksFor', () => {
  const names = (url: string, interval = 5) => defaultChecksFor(url, interval).map((c) => c.name);

  it('always includes the landing uptime check at the chosen interval', () => {
    const specs = defaultChecksFor('https://shop.example.com', 3);
    expect(specs[0]!.name).toBe('Landing uptime');
    expect(specs[0]!.intervalMinutes).toBe(3);
    expect(specs[0]!.config).toMatchObject({ mode: 'http', expectedStatus: 200 });
  });

  it('adds DNS and TLS for an https site with a hostname', () => {
    expect(names('https://shop.example.com')).toEqual(['Landing uptime', 'DNS resolves', 'TLS certificate']);
  });

  // Nothing to resolve, so a DNS check would fail on day one.
  it('skips DNS for an IP literal', () => {
    expect(names('https://10.0.0.5')).toEqual(['Landing uptime', 'TLS certificate']);
    expect(names('http://[2001:db8::1]:8080')).toEqual(['Landing uptime']);
  });

  // No certificate to inspect over plain HTTP.
  it('skips the TLS check for an http site', () => {
    expect(names('http://intranet.example.com')).toEqual(['Landing uptime', 'DNS resolves']);
  });

  it('targets the URL port for the TLS check, not always 443', () => {
    const tls = defaultChecksFor('https://shop.example.com:8443', 5).find((c) => c.name === 'TLS certificate')!;
    expect(tls.config).toMatchObject({ mode: 'port', port: 8443, tls: true, certExpiryWarningDays: 14 });
  });

  // A self-signed internal service is healthy from the operator's point of
  // view, so the default must not fail on it. Nothing is lost: the landing
  // uptime check runs in Chromium, which already refuses an untrusted
  // certificate, and the expiry warning works regardless of this flag.
  it('does not enforce chain trust on the default TLS check', () => {
    const tls = defaultChecksFor('https://selfsigned.internal', 5).find((c) => c.name === 'TLS certificate')!;
    expect(tls.config).toMatchObject({ allowInsecureCert: true, certExpiryWarningDays: 14 });
  });

  // Slower than uptime on purpose: neither changes minute to minute.
  it('gives DNS and TLS their own slower cadences', () => {
    const specs = defaultChecksFor('https://shop.example.com', 1);
    expect(specs.find((c) => c.name === 'DNS resolves')!.intervalMinutes).toBe(15);
    expect(specs.find((c) => c.name === 'TLS certificate')!.intervalMinutes).toBe(60);
  });

  // ICMP is blocked by most CDNs; a default ping would report a healthy site
  // as unreachable and drag the badge down on day one.
  it('never includes a ping check', () => {
    for (const url of ['https://a.example.com', 'http://b.example.com', 'https://10.0.0.1']) {
      expect(defaultChecksFor(url, 5).some((c) => (c.config as { mode?: string }).mode === 'ping')).toBe(false);
    }
  });

  it('degrades to the uptime check alone when the URL will not parse', () => {
    expect(names('not a url')).toEqual(['Landing uptime']);
  });
});
