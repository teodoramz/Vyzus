// DNS executor. Catches the failure where the service itself is fine but nobody
// can find it: an expired domain, a botched record change, a stale secondary, a
// hijacked zone. None of those show up in an HTTP check run from a machine whose
// resolver still has the old answer cached.
//
// node:dns only — no new dependency.
import { Resolver } from 'node:dns/promises';
import type { DnsModeConfig } from '@vyzus/shared';
import { truncateError, type ExecutionResult } from './types.js';

export interface DnsInput {
  config: DnsModeConfig;
  timeoutMs: number;
}

/** Flatten each record type to comparable strings, so assertions are uniform. */
function flatten(recordType: DnsModeConfig['recordType'], records: unknown): string[] {
  if (!Array.isArray(records)) return [];
  switch (recordType) {
    case 'MX':
      return (records as { priority: number; exchange: string }[]).map((r) => `${r.priority} ${r.exchange}`);
    case 'TXT':
      // node returns TXT as string[][] — a record can be split into chunks that
      // are meant to be concatenated, which is how long SPF/DKIM values travel.
      return (records as string[][]).map((chunks) => chunks.join(''));
    default:
      return (records as string[]).map(String);
  }
}

export async function executeDns(input: DnsInput): Promise<ExecutionResult> {
  const { config, timeoutMs } = input;
  const startedAt = Date.now();

  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (config.resolver) {
    try {
      resolver.setServers([config.resolver]);
    } catch {
      return {
        status: 'error',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: `Not a usable resolver address: ${config.resolver}`,
        screenshotPath: null,
        tracePath: null,
      };
    }
  }

  let values: string[];
  try {
    const records = await resolver.resolve(config.host, config.recordType);
    values = flatten(config.recordType, records);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    return {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      metrics: { host: config.host, recordType: config.recordType, resolver: config.resolver ?? 'system' },
      // NXDOMAIN and friends are the answer, not an infrastructure fault, so
      // this is `failed` rather than `error`.
      errorMessage: truncateError(`DNS ${config.recordType} lookup for ${config.host} failed — ${code}`),
      screenshotPath: null,
      tracePath: null,
    };
  }

  const durationMs = Date.now() - startedAt;
  const metrics: Record<string, unknown> = {
    host: config.host,
    recordType: config.recordType,
    resolver: config.resolver ?? 'system',
    records: values,
    recordCount: values.length,
  };

  if (values.length === 0) {
    return {
      status: 'failed',
      durationMs,
      metrics,
      errorMessage: `DNS ${config.recordType} lookup for ${config.host} returned no records`,
      screenshotPath: null,
      tracePath: null,
    };
  }

  // Substring rather than equality: an MX answer carries a priority and a TXT
  // value is often a long policy string, so requiring the whole thing verbatim
  // would make the assertion unusable in exactly the cases people want it.
  const missing = config.expectedValues.filter((want) => !values.some((got) => got.includes(want)));
  if (missing.length > 0) {
    return {
      status: 'failed',
      durationMs,
      metrics,
      errorMessage: truncateError(
        `DNS ${config.recordType} for ${config.host} is missing ${missing.map((m) => `"${m}"`).join(', ')} — got ${values.join(', ')}`,
      ),
      screenshotPath: null,
      tracePath: null,
    };
  }

  return { status: 'passed', durationMs, metrics, errorMessage: null, screenshotPath: null, tracePath: null };
}
