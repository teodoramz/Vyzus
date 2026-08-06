import { describe, expect, it } from 'vitest';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { TokenService } from '../lib/tokens.js';
import { deriveAppStatus } from '../lib/queries.js';
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
  it('is UNKNOWN when there is no uptime check at all', () => {
    expect(deriveAppStatus(true, [])).toBe('UNKNOWN');
    expect(deriveAppStatus(true, [check({ type: 'journey', lastStatus: 'failed' })])).toBe('UNKNOWN');
  });

  it('ignores a failing journey check entirely — only uptime checks drive the badge', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'passed' }),
      check({ id: 'j1', type: 'journey', lastStatus: 'failed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('UP');
  });

  it('goes DOWN on a failing uptime check regardless of a passing journey check', () => {
    const checks = [
      check({ id: 'u1', type: 'uptime', lastStatus: 'failed' }),
      check({ id: 'j1', type: 'journey', lastStatus: 'passed' }),
    ];
    expect(deriveAppStatus(true, checks)).toBe('DOWN');
  });

  it('is PAUSED when the app is disabled or every uptime check is disabled', () => {
    expect(deriveAppStatus(false, [check({ lastStatus: 'passed' })])).toBe('PAUSED');
    expect(deriveAppStatus(true, [check({ enabled: false, lastStatus: 'passed' })])).toBe('PAUSED');
  });

  it('is UNKNOWN when the (only) enabled uptime check has never run', () => {
    expect(deriveAppStatus(true, [check({ lastStatus: null })])).toBe('UNKNOWN');
  });
});

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

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
