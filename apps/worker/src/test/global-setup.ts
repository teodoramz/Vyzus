// vitest globalSetup for the worker suite: bring up dockerized Postgres+Redis
// (docker-compose.test.yml at the repo root), apply migrations (via the API
// package's migrate script), and build this package so the sandbox harness
// exists at dist/sandbox/runner-harness.js (the child runs plain node).
// Set VYZUS_TEST_NO_DOCKER=1 when the services are already provided.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEST_DATABASE_URL } from './env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export default async function setup(): Promise<void> {
  if (process.env.VYZUS_TEST_NO_DOCKER !== '1') {
    execSync('docker compose -f docker-compose.test.yml up -d --wait', {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  execSync('pnpm --filter @vyzus/api db:migrate', {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  execSync('pnpm --filter @vyzus/worker build', { cwd: repoRoot, stdio: 'inherit' });
}
