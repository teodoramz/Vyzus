// Worker environment configuration, validated at boot.
import os from 'node:os';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ARTIFACTS_DIR: z.string().default('/data/artifacts'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Needed to decrypt per-app credentials at run time (02-architecture §7).
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars'),
  // Test override: cap the scheduled-run jitter (default 15 s per FR-3.2).
  MAX_JITTER_MS: z.coerce.number().int().min(0).max(15_000).default(15_000),
});

export type WorkerConfig = z.infer<typeof envSchema> & { workerId: string };

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid worker environment:\n${issues}`);
  }
  return { ...parsed.data, workerId: os.hostname() };
}
