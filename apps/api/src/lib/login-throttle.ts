// Login throttling (backlog task 10). `POST /auth/login` had no backoff, so a
// self-hosted instance reachable on an internal network was an unlimited
// password-guessing oracle.
//
// Redis-backed rather than in-memory: Redis is already a hard dependency of the
// API process, so this costs nothing extra, survives a restart (an attacker
// cannot clear their own counter by waiting for a deploy), and stays correct if
// the API is ever run with more than one replica.
//
// Two independent counters, and either can lock:
//   - per email — stops one account being ground down from many addresses
//   - per client IP — stops one host spraying many accounts
// Only *failed* attempts count; a success clears both.
import type { Redis } from 'ioredis';

/** Failures tolerated inside the window before the next attempt is refused. */
export const LOGIN_MAX_ATTEMPTS = 8;
/** Sliding window, in seconds. Also how long a lockout lasts. */
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const PREFIX = 'vyzus:login-throttle';

/** Emails are case-insensitive here, so the counter must be too. */
function keys(email: string, ip: string): string[] {
  return [`${PREFIX}:email:${email.trim().toLowerCase()}`, `${PREFIX}:ip:${ip}`];
}

export interface ThrottleVerdict {
  allowed: boolean;
  /** Seconds until the caller may try again. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Checked *before* the password is verified, so a locked-out caller costs no
 * argon2 work — otherwise the throttle would still let an attacker consume CPU.
 */
export async function checkLoginAllowed(redis: Redis, email: string, ip: string): Promise<ThrottleVerdict> {
  const ks = keys(email, ip);
  const pipeline = redis.multi();
  for (const k of ks) {
    pipeline.get(k);
    pipeline.ttl(k);
  }
  const replies = await pipeline.exec();
  if (!replies) return { allowed: true, retryAfterSeconds: 0 };

  let retryAfterSeconds = 0;
  for (let i = 0; i < ks.length; i++) {
    const count = Number(replies[i * 2]?.[1] ?? 0);
    const ttl = Number(replies[i * 2 + 1]?.[1] ?? 0);
    if (count >= LOGIN_MAX_ATTEMPTS) {
      // A key with no expiry (ttl -1) would lock forever; treat it as a full
      // window rather than trusting the stored state.
      retryAfterSeconds = Math.max(retryAfterSeconds, ttl > 0 ? ttl : LOGIN_WINDOW_SECONDS);
    }
  }

  return retryAfterSeconds > 0 ? { allowed: false, retryAfterSeconds } : { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Record one failed attempt. The window is set on first failure and not
 * extended by later ones, so it is a fixed window from the first bad password
 * rather than a lockout an attacker can keep alive indefinitely.
 */
export async function recordLoginFailure(redis: Redis, email: string, ip: string): Promise<void> {
  const pipeline = redis.multi();
  for (const k of keys(email, ip)) {
    pipeline.incr(k);
    // NX: only set a TTL if the key has none, i.e. on the first failure.
    pipeline.expire(k, LOGIN_WINDOW_SECONDS, 'NX');
  }
  await pipeline.exec();
}

/** A correct password clears the record — legitimate users are never punished. */
export async function clearLoginFailures(redis: Redis, email: string, ip: string): Promise<void> {
  await redis.del(...keys(email, ip));
}
