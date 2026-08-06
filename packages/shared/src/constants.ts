// Shared enum literals and constants — the single source of truth for the
// small closed vocabularies used across API, worker, and dashboard.

export const USER_ROLES = ['admin', 'editor', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CHECK_TYPES = ['uptime', 'journey'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** An `uptime` check's mode — what it actually probes. 'http' is the
 * original browser-based check; 'port' is a raw TCP/UDP reachability probe.
 * Both are "is the thing itself up" checks (unlike `journey`), so they share
 * the `uptime` check type and drive the app's Up/Down badge the same way —
 * only the config shape and executor differ. */
export const UPTIME_MODES = ['http', 'port'] as const;
export type UptimeMode = (typeof UPTIME_MODES)[number];

export const PORT_PROTOCOLS = ['tcp', 'udp'] as const;
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];

/** 'auto' lets the OS/DNS resolver pick; '4'/'6' forces a family. */
export const IP_FAMILIES = ['auto', '4', '6'] as const;
export type IpFamily = (typeof IP_FAMILIES)[number];

/** Terminal status of a single run / denormalized last_status of a check. */
export const RUN_STATUSES = ['passed', 'failed', 'error', 'timeout'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What caused a run to be enqueued. */
export const RUN_TRIGGERS = ['schedule', 'manual', 'screenshot'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * When an uptime (http-mode) check stores a screenshot.
 * - `always`     — every run.
 * - `on_change`  — every failure, plus the first success after a failure, so
 *                  you get both "what broke" and "what it looked like when it
 *                  came back" without a file per healthy run.
 * - `on_failure` — failures only.
 * - `never`      — only when the Screenshot button is pressed.
 *
 * `on_change` and `on_failure` can additionally be given a
 * `screenshotRefreshMinutes` so a healthy check still refreshes its picture
 * periodically (see DEFAULT_SCREENSHOT_REFRESH_MINUTES).
 */
export const SCREENSHOT_MODES = ['always', 'on_change', 'on_failure', 'never'] as const;
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];

/** Default cadence for the periodic refresh on a healthy check. */
export const DEFAULT_SCREENSHOT_REFRESH_MINUTES = 60;

export const CHANNEL_TYPES = ['slack', 'discord', 'webhook'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const ALERT_EVENTS = ['down', 'recovered'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const DELIVERY_STATUSES = ['sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Derived, never-stored application status shown on the overview grid. */
export const APP_STATUSES = ['UP', 'DEGRADED', 'DOWN', 'PAUSED', 'UNKNOWN'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

// Limits / defaults referenced by both validation and business logic.
export const JOURNEY_SPEC_MAX_BYTES = 64 * 1024; // 64 KB
export const ERROR_MESSAGE_MAX_BYTES = 4 * 1024; // 4 KB
export const DEFAULT_INTERVAL_MINUTES = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_FAILURE_THRESHOLD = 2;
export const MAX_JITTER_MS = 15_000;

// Settings keys (single-row key/value store) and their defaults.
export const SETTINGS_KEYS = {
  runsDays: 'retention.runs_days',
  screenshotsDays: 'retention.screenshots_days',
  tracesDays: 'retention.traces_days',
} as const;

export const DEFAULT_RETENTION = {
  runsDays: 90,
  screenshotsDays: 30,
  tracesDays: 14,
} as const;
