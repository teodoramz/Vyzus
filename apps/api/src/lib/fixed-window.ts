// Redis fixed-window counter for the public endpoint limiters.
//
// Fixed rather than sliding: a sliding window needs a sorted set per client,
// and this is a coarse abuse guard, not a quota system.
import type { Redis } from 'ioredis';

export interface WindowVerdict {
  allowed: boolean;
  /** Seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

export async function hitFixedWindow(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<WindowVerdict> {
  const count = await redis.incr(key);
  if (count === 1) {
    // Never extended, so a caller cannot keep their own lockout alive by
    // continuing to knock.
    await redis.expire(key, windowSeconds);
  }
  if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
  const ttl = await redis.ttl(key);
  return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
}
