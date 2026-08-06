// vitest globalSetup: bring up the dockerized Postgres + Redis (published on
// 5433/6380 via docker-compose.test.yml) and apply migrations once before the
// suite. Set VYZUS_TEST_NO_DOCKER=1 to skip `compose up` when the DB/Redis
// are already provided (e.g. running inside the compose network).
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { TEST_DATABASE_URL } from './env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export default async function setup(): Promise<void> {
  if (process.env.VYZUS_TEST_NO_DOCKER !== '1') {
    execSync('docker compose -f docker-compose.test.yml up -d --wait', {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  await runMigrations(TEST_DATABASE_URL);
  // The full-stack smoke test imports @vyzus/worker/testkit (dist) and runs a
  // real worker in-process, so build the worker (+ its sandbox harness) first.
  execSync('pnpm --filter @vyzus/worker build', { cwd: repoRoot, stdio: 'inherit' });
}
