// Concurrent migrations must not race.
//
// Drizzle's migrator does not lock: it reads which migrations are applied, then
// applies the rest. Two API processes starting together — which is exactly what
// `docker compose up -d --build api` does for a moment — both read "none
// applied" and both try to apply, so the loser dies on an object the winner has
// already created. runMigrations() serialises them with a Postgres advisory
// lock; this test is the reproduction.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '../db/migrate.js';
import { TEST_DATABASE_URL } from './env.js';

/** Admin connection to the maintenance DB, for CREATE/DROP DATABASE. */
let admin: postgres.Sql;
const created: string[] = [];

function urlFor(dbName: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

beforeAll(() => {
  admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
});

afterEach(async () => {
  // Drop outside the migration connections, which have already closed.
  for (const name of created.splice(0)) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
});

async function freshDatabase(): Promise<string> {
  const name = `vyzus_migrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created.push(name);
  return name;
}

describe('runMigrations concurrency', () => {
  it('lets several processes migrate a fresh database simultaneously', async () => {
    const name = await freshDatabase();
    const url = urlFor(name);

    // Four at once: more than the two a redeploy produces, so a lock that only
    // happens to work for a pair would still be caught.
    const results = await Promise.allSettled([
      runMigrations(url),
      runMigrations(url),
      runMigrations(url),
      runMigrations(url),
    ]);

    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

    // And the schema really is complete, not merely un-crashed: every
    // migration recorded exactly once, with the newest tables present.
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
      `;
      expect(rows[0]!.count).toBeGreaterThan(0);

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `;
      const names = tables.map((t) => t.table_name);
      for (const expected of ['users', 'applications', 'checks', 'runs', 'api_tokens', 'maintenance_windows']) {
        expect(names).toContain(expected);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it('is a no-op when run again against an already-migrated database', async () => {
    const name = await freshDatabase();
    const url = urlFor(name);

    await runMigrations(url);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    let before: number;
    try {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
      `;
      before = rows[0]!.count;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await expect(runMigrations(url)).resolves.toBeUndefined();

    const sql2 = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql2<{ count: number }[]>`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
      `;
      expect(rows[0]!.count).toBe(before);
    } finally {
      await sql2.end({ timeout: 5 });
    }
  }, 120_000);

  it('releases the lock, so a later run is not blocked by an earlier one', async () => {
    const name = await freshDatabase();
    const url = urlFor(name);
    await runMigrations(url);

    // Would hang (and time out) if the advisory lock leaked.
    await expect(runMigrations(url)).resolves.toBeUndefined();

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const held = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
      `;
      expect(held[0]!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
