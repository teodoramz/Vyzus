// Drizzle schema — the exact Postgres data model from 03-data-model.md.
// Lives in @vyzus/shared (subpath export `@vyzus/shared/db`) because both
// the API and the worker need it, and the worker image never ships apps/api
// sources; apps/api/src/db/schema.ts re-exports this module so drizzle-kit and
// all API imports stay unchanged.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { UptimeConfig, JourneyConfig } from '../schemas/checks.js';
import type { ChannelConfig } from '../schemas/channels.js';

// ---- Enums ----
export const userRoleEnum = pgEnum('user_role', ['admin', 'editor', 'viewer']);
export const checkTypeEnum = pgEnum('check_type', ['uptime', 'journey']);
export const runStatusEnum = pgEnum('run_status', ['passed', 'failed', 'error', 'timeout']);
export const runTriggerEnum = pgEnum('run_trigger', ['schedule', 'manual', 'screenshot']);
export const channelTypeEnum = pgEnum('channel_type', ['slack', 'discord', 'webhook']);
export const alertEventEnum = pgEnum('alert_event', ['down', 'recovered']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['sent', 'failed']);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

// ---- users ----
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull(),
  refreshTokenHash: text('refresh_token_hash'),
  createdAt,
  updatedAt,
});

// ---- applications ----
export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  landingUrl: text('landing_url').notNull(),
  tags: text('tags')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  authConfigEnc: text('auth_config_enc'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt,
  updatedAt,
});

// ---- user_app_access ----
// Which applications a `viewer` user may see/act on. Admin (and editor,
// implicitly, since editor already has unrestricted app access) rows never
// need an entry here — only consulted for role = 'viewer'. Managed by
// admins via PUT /users/:id/apps.
export const userAppAccess = pgTable(
  'user_app_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.appId] })],
);

// ---- checks ----
export type CheckConfigJson = UptimeConfig | JourneyConfig;

export const checks = pgTable(
  'checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    type: checkTypeEnum('type').notNull(),
    name: text('name').notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    failureThreshold: integer('failure_threshold').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<CheckConfigJson>().notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastStatus: runStatusEnum('last_status'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    // User-controlled tab/run-all order (not creation order) — lower first.
    // New checks get the next value after the app's current max.
    sortOrder: integer('sort_order').notNull().default(0),
    // When this check last stored a screenshot. Drives the periodic refresh in
    // `screenshotRefreshMinutes`. A column rather than a MAX() over runs so the
    // cadence stays a single indexed read on the hot path.
    // (Dropped in 0006: current_screenshot_run_id / current_screenshot_path,
    // which existed only to supersede a streak's screenshot. Every screenshot
    // is kept now, so there is nothing to point at.)
    lastScreenshotAt: timestamp('last_screenshot_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [index('checks_app_id_idx').on(t.appId), check('checks_interval_min_chk', sql`${t.intervalMinutes} >= 1`)],
);

// ---- runs ----
export type RunMetricsJson = Record<string, unknown>;

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkId: uuid('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    status: runStatusEnum('status').notNull(),
    trigger: runTriggerEnum('trigger').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    metrics: jsonb('metrics').$type<RunMetricsJson>(),
    errorMessage: text('error_message'),
    screenshotPath: text('screenshot_path'),
    tracePath: text('trace_path'),
    workerId: text('worker_id'),
  },
  (t) => [
    index('runs_check_started_idx').on(t.checkId, t.startedAt.desc()),
    index('runs_check_failed_idx')
      .on(t.checkId)
      .where(sql`${t.status} <> 'passed'`),
  ],
);

// ---- incidents ----
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkId: uuid('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    openingRunId: uuid('opening_run_id').references(() => runs.id, { onDelete: 'set null' }),
    resolvingRunId: uuid('resolving_run_id').references(() => runs.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('incidents_one_open_per_check_idx')
      .on(t.checkId)
      .where(sql`${t.resolvedAt} IS NULL`),
    index('incidents_check_idx').on(t.checkId),
  ],
);

// ---- alert_channels ----
export const alertChannels = pgTable('alert_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: channelTypeEnum('type').notNull(),
  config: jsonb('config').$type<ChannelConfig>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  allApps: boolean('all_apps').notNull().default(true),
  // NULL = an admin/editor-managed "global" channel (unchanged v1 behavior).
  // Non-null = self-service, created by a viewer for their own notifications;
  // visible/manageable only by that viewer (and admins/editors, for
  // oversight) — see lib/access.ts assertChannelOwnership().
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  // Who created this channel — always set, regardless of role (unlike
  // ownerId, which only carries the self-service access-control meaning
  // above and is NULL for admin/editor-managed global channels). Kept even
  // if ownerId's cascade-delete rule doesn't apply: deleting the creator
  // must not delete a shared global channel, so this is set null instead.
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt,
  updatedAt,
});

// ---- app_alert_channels (join) ----
export const appAlertChannels = pgTable(
  'app_alert_channels',
  {
    appId: uuid('app_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => alertChannels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.appId, t.channelId] })],
);

// ---- alert_deliveries ----
export const alertDeliveries = pgTable('alert_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => alertChannels.id, { onDelete: 'cascade' }),
  event: alertEventEnum('event').notNull(),
  status: deliveryStatusEnum('status').notNull(),
  attempts: integer('attempts').notNull(),
  responseCode: integer('response_code'),
  createdAt,
});

// ---- settings (single-row key/value) ----
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
});

// ---- Relations (Drizzle query API) ----
export const applicationsRelations = relations(applications, ({ many }) => ({
  checks: many(checks),
  appAlertChannels: many(appAlertChannels),
}));

export const checksRelations = relations(checks, ({ one, many }) => ({
  application: one(applications, {
    fields: [checks.appId],
    references: [applications.id],
  }),
  runs: many(runs),
  incidents: many(incidents),
}));

export const runsRelations = relations(runs, ({ one }) => ({
  check: one(checks, { fields: [runs.checkId], references: [checks.id] }),
}));

export const incidentsRelations = relations(incidents, ({ one }) => ({
  check: one(checks, { fields: [incidents.checkId], references: [checks.id] }),
  openingRun: one(runs, {
    fields: [incidents.openingRunId],
    references: [runs.id],
    relationName: 'opening_run',
  }),
  resolvingRun: one(runs, {
    fields: [incidents.resolvingRunId],
    references: [runs.id],
    relationName: 'resolving_run',
  }),
}));

export const alertChannelsRelations = relations(alertChannels, ({ many }) => ({
  appAlertChannels: many(appAlertChannels),
  deliveries: many(alertDeliveries),
}));

export const appAlertChannelsRelations = relations(appAlertChannels, ({ one }) => ({
  application: one(applications, {
    fields: [appAlertChannels.appId],
    references: [applications.id],
  }),
  channel: one(alertChannels, {
    fields: [appAlertChannels.channelId],
    references: [alertChannels.id],
  }),
}));

export const alertDeliveriesRelations = relations(alertDeliveries, ({ one }) => ({
  incident: one(incidents, {
    fields: [alertDeliveries.incidentId],
    references: [incidents.id],
  }),
  channel: one(alertChannels, {
    fields: [alertDeliveries.channelId],
    references: [alertChannels.id],
  }),
}));

// ---- Inferred row types ----
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ApplicationRow = typeof applications.$inferSelect;
export type NewApplicationRow = typeof applications.$inferInsert;
export type CheckRow = typeof checks.$inferSelect;
export type NewCheckRow = typeof checks.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;
export type AlertChannelRow = typeof alertChannels.$inferSelect;
export type NewAlertChannelRow = typeof alertChannels.$inferInsert;
export type AlertDeliveryRow = typeof alertDeliveries.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
