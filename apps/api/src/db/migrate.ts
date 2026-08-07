// Runs pending Drizzle migrations then exits. Invoked by `pnpm db:migrate` and
// reused by the API boot sequence (runMigrations) before the server listens.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// The migrations dir must be found whether this file runs unbundled (tsx, at
// src/db/migrate.ts), bundled (tsup → dist/index.js), or in the container
// (WORKDIR /app, drizzle deployed to /app/drizzle). Probe the likely locations.
function resolveMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(here, '../../drizzle'), // dev: src/db → apps/api/drizzle
    path.resolve(here, '../drizzle'), // bundled: dist → package root/drizzle
  ];
  return candidates.find((c) => existsSync(path.join(c, 'meta', '_journal.json'))) ?? candidates[0]!;
}

const migrationsFolder = resolveMigrationsFolder();

/**
 * Fixed key for the migration advisory lock. Arbitrary but stable — only ever
 * compared against itself. ("VYZU" as hex, so it is recognisable in
 * `pg_locks` when someone is working out who is holding it.)
 */
const MIGRATION_LOCK_KEY = 0x56595a55;

export async function runMigrations(databaseUrl: string): Promise<void> {
  // A dedicated single connection for migrations, so the advisory lock below
  // and migrate() itself share one session — the lock is session-scoped, and
  // taking it on a different pooled connection would not protect anything.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // Drizzle's migrator does not lock: it creates the bookkeeping table if
    // absent, reads which migrations are applied, then applies the rest. Two
    // API processes starting together — which is exactly what
    // `docker compose up -d --build api` does, briefly — both read "none
    // applied" and both try to apply, so the loser dies on an object that now
    // already exists ("constraint ... does not exist", "relation ... already
    // exists"). It restarted and recovered, but a fatal boot error on every
    // redeploy is not something an operator should have to learn to ignore.
    //
    // Blocking, not try-lock: the second process should wait and then find
    // nothing to do, rather than start serving against a half-migrated schema.
    // A crashed holder releases automatically when its session ends.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      // Read *after* acquiring the lock, so a process that waited sees what the
      // winner just applied instead of its own stale view.
      const db = drizzle(sql);
      await migrate(db, { migrationsFolder });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  await runMigrations(url);
  console.log('Migrations applied.');
}

// Run as a script when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
