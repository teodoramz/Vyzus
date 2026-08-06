// The Drizzle schema definition lives in @vyzus/shared (subpath `/db`) so
// the worker can import it without shipping apps/api sources (03-data-model
// intent: single definition, worker reads it via the shared package). This
// module re-exports it so drizzle-kit and every existing API import keep
// working unchanged.
export * from '@vyzus/shared/db';
