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

export async function runMigrations(databaseUrl: string): Promise<void> {
  // A dedicated single connection for migrations (max: 1 avoids advisory-lock
  // contention across a pool).
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder });
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
