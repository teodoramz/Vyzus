// Environment configuration, validated once at boot with Zod so a misconfigured
// deployment fails fast with a clear message instead of at first use.
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  // 32-byte key as 64 hex chars for AES-256-GCM
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars'),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  ARTIFACTS_DIR: z.string().default('/data/artifacts'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(7),
});

export type AppConfig = z.infer<typeof envSchema> & { isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' };
}
