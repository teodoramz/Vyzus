// Login throttling: POST /auth/login had no backoff, making a reachable
// instance an unlimited password-guessing oracle. These tests drive the real
// route against real Redis, since the contract is about state that survives
// between requests.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_MAX_ATTEMPTS } from '../lib/login-throttle.js';
import { buildTestApp, closeTestApp, resetDb, ADMIN_EMAIL, ADMIN_PASSWORD, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

beforeEach(async () => {
  // resetDb clears the Redis throttle counters too — see helpers.ts.
  await resetDb(ctx);
});

function login(password: string, email = ADMIN_EMAIL) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
}

describe('login throttling', () => {
  it('locks out after the attempt budget and answers 429 with Retry-After', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      expect((await login('wrong-password')).statusCode).toBe(401);
    }

    const blocked = await login('wrong-password');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  // The lockout must hold even for someone who then guesses correctly —
  // otherwise it only slows down attackers who never succeed.
  it('refuses the correct password too, once locked out', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) await login('wrong-password');
    expect((await login(ADMIN_PASSWORD)).statusCode).toBe(429);
  });

  it('lets a correct password through below the budget, and clears the count', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      expect((await login('wrong-password')).statusCode).toBe(401);
    }

    expect((await login(ADMIN_PASSWORD)).statusCode).toBe(200);

    // The successful login reset both counters, so the budget is full again
    // rather than one attempt from a lockout.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      expect((await login('wrong-password')).statusCode).toBe(401);
    }
    expect((await login(ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it('counts attempts against an unknown email as well', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      expect((await login('whatever', 'ghost@example.com')).statusCode).toBe(401);
    }
    expect((await login('whatever', 'ghost@example.com')).statusCode).toBe(429);
  });

  it('is case-insensitive on the email counter', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) await login('wrong-password', ADMIN_EMAIL.toUpperCase());
    // Same account, different casing — must hit the same counter.
    expect((await login('wrong-password', ADMIN_EMAIL)).statusCode).toBe(429);
  });

  // Setup is single-use and already 409s afterwards, so throttling it would
  // only add a way to lock a fresh install out of its own first login.
  it('does not throttle POST /auth/setup', async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 2; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { email: 'founder@example.com', password: 'a-long-enough-password' },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
