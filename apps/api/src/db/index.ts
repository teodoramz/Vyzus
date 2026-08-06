// Postgres connection + Drizzle db factory. One place constructs the client so
// plugins, migrations, seed, and tests share the same wiring.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Database;
  sql: ReturnType<typeof postgres>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, { max: opts.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export { schema };
