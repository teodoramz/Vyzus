// Test connection URLs (same convention as the API suite): dockerized
// Postgres on 5433 / Redis on 6380 from docker-compose.test.yml, overridable
// with TEST_DATABASE_URL / TEST_REDIS_URL.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://vyzus:vyzus@localhost:5433/vyzus_test';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
