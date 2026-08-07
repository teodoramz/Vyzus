import { describe, expect, it } from 'vitest';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { TokenService } from '../lib/tokens.js';
import { deriveAppStatus } from '../lib/queries.js';
import { loadConfig } from '../config.js';
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
    currentScreenshotRunId: null,
    currentScreenshotPath: null,
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
