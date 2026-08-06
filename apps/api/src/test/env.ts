// Connection URLs for the integration tests. Imported by both the vitest
// globalSetup and the test files so they agree without relying on env
// propagation across vitest worker processes. Override with TEST_DATABASE_URL /
// TEST_REDIS_URL (e.g. to run inside the compose network).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://vyzus:vyzus@localhost:5433/vyzus_test';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
