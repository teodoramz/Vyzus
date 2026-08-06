// Pure functions mapping Drizzle rows to the Zod response shapes. Timestamps
// become ISO strings and secrets are redacted here, so routes never hand raw
// rows to the serializer.
import type {
  User,
  Check,
  App,
  Channel,
  Incident,
  Run,
  AppRun,
  Settings,
  UptimeConfig,
  JourneyConfig,
} from '@vyzus/shared';
import { DEFAULT_RETENTION } from '@vyzus/shared';
import type { UserRow, CheckRow, ApplicationRow, AlertChannelRow, IncidentRow, RunRow } from '../db/schema.js';

const iso = (d: Date): string => d.toISOString();

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toApp(row: ApplicationRow): App {
  return {
    id: row.id,
    name: row.name,
    landingUrl: row.landingUrl,
    tags: row.tags,
    hasAuthConfig: row.authConfigEnc != null,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toCheck(row: CheckRow): Check {
  return {
    id: row.id,
    appId: row.appId,
    type: row.type,
    name: row.name,
    intervalMinutes: row.intervalMinutes,
    timeoutMs: row.timeoutMs,
    failureThreshold: row.failureThreshold,
    enabled: row.enabled,
    config: row.config as UptimeConfig | JourneyConfig,
    consecutiveFailures: row.consecutiveFailures,
    lastStatus: row.lastStatus,
    lastRunAt: row.lastRunAt ? iso(row.lastRunAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toChannel(row: AlertChannelRow, appIds: string[], createdByEmail: string | null): Channel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.config.url,
    hasSecret: row.config.secret != null,
    enabled: row.enabled,
    allApps: row.allApps,
    appIds,
    ownerId: row.ownerId,
    createdBy: row.createdBy,
    createdByEmail,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toIncident(row: IncidentRow, names?: { appId: string; appName: string; checkName: string }): Incident {
  const downtimeSeconds =
    row.resolvedAt != null ? Math.max(0, Math.round((row.resolvedAt.getTime() - row.openedAt.getTime()) / 1000)) : null;
  return {
    id: row.id,
    checkId: row.checkId,
    openedAt: iso(row.openedAt),
    resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    openingRunId: row.openingRunId,
    resolvingRunId: row.resolvingRunId,
    downtimeSeconds,
    ...(names ? { appId: names.appId, appName: names.appName, checkName: names.checkName } : {}),
  };
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    checkId: row.checkId,
    status: row.status,
    trigger: row.trigger,
    startedAt: iso(row.startedAt),
    durationMs: row.durationMs,
    metrics: row.metrics ?? null,
    errorMessage: row.errorMessage,
    hasScreenshot: row.screenshotPath != null,
    hasTrace: row.tracePath != null,
    workerId: row.workerId,
  };
}

export function toAppRun(row: RunRow, check: { name: string; type: CheckRow['type'] }): AppRun {
  return { ...toRun(row), checkName: check.name, checkType: check.type };
}

export function toSettings(rows: { key: string; value: unknown }[]): Settings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, fallback: number): number => {
    const v = map.get(k);
    return typeof v === 'number' ? v : fallback;
  };
  return {
    runsDays: num('retention.runs_days', DEFAULT_RETENTION.runsDays),
    screenshotsDays: num('retention.screenshots_days', DEFAULT_RETENTION.screenshotsDays),
    tracesDays: num('retention.traces_days', DEFAULT_RETENTION.tracesDays),
  };
}
