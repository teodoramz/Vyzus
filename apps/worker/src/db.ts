// Worker's Postgres access — the same Drizzle schema the API owns, imported
// via the shared package (see @vyzus/shared/db for the rationale). The
// worker only writes runs, denormalized check fields, and incidents.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@vyzus/shared/db';

export type WorkerDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkerDbHandle {
  db: WorkerDatabase;
  sql: ReturnType<typeof postgres>;
}

export function createWorkerDb(databaseUrl: string, opts: { max?: number } = {}): WorkerDbHandle {
  const sql = postgres(databaseUrl, { max: opts.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export { schema };
