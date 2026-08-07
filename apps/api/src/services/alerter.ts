// Alert dispatcher (Phase 5). A BullMQ Worker inside the API process consumes
// the `alerts` queue (fed by the worker's incident state machine), renders the
// payload per channel type (Slack Block Kit / Discord embed / generic JSON with
// HMAC signature), POSTs with 3-attempt exponential backoff, and logs every
// outcome in `alert_deliveries`. Channel selection honours `all_apps` and the
// `app_alert_channels` bindings.
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  QUEUE_NAMES,
  ALERT_SIGNATURE_HEADER,
  alertJobPayloadSchema,
  isMonitoringAlert,
  type AlertWebhookPayload,
  type MonitoringAlertWebhookPayload,
  type AlertEvent,
  type ChannelType,
} from '@vyzus/shared';
import type { Database } from '../db/index.js';
import {
  alertChannels,
  alertDeliveries,
  appAlertChannels,
  applications,
  checks,
  incidents,
  runs,
  type AlertChannelRow,
} from '../db/schema.js';

// ---- Payload construction ----

export async function buildAlertPayload(
  db: Database,
  incidentId: string,
  event: AlertEvent,
  publicUrl: string,
): Promise<{ payload: AlertWebhookPayload; appId: string } | null> {
  const [row] = await db
    .select({ incident: incidents, check: checks, app: applications })
    .from(incidents)
    .innerJoin(checks, eq(incidents.checkId, checks.id))
    .innerJoin(applications, eq(checks.appId, applications.id))
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!row) return null;

  const runId = event === 'down' ? row.incident.openingRunId : row.incident.resolvingRunId;
  const [runRow] = runId ? await db.select().from(runs).where(eq(runs.id, runId)).limit(1) : [undefined];

  const downtimeSeconds =
    row.incident.resolvedAt != null
      ? Math.max(0, Math.round((row.incident.resolvedAt.getTime() - row.incident.openedAt.getTime()) / 1000))
      : null;

  const payload: AlertWebhookPayload = {
    event: event === 'down' ? 'check.down' : 'check.recovered',
    application: { id: row.app.id, name: row.app.name, landingUrl: row.app.landingUrl },
    check: { id: row.check.id, name: row.check.name, type: row.check.type },
    incident: {
      id: row.incident.id,
      openedAt: row.incident.openedAt.toISOString(),
      resolvedAt: row.incident.resolvedAt ? row.incident.resolvedAt.toISOString() : null,
      downtimeSeconds,
    },
    run: {
      id: runRow?.id ?? row.incident.openingRunId ?? row.incident.id,
      status: runRow?.status ?? (event === 'down' ? 'failed' : 'passed'),
      errorMessage: runRow?.errorMessage ?? null,
      screenshotUrl: runRow?.screenshotPath ? `${publicUrl}/api/v1/runs/${runRow.id}/artifacts/screenshot` : null,
    },
    timestamp: new Date().toISOString(),
  };
  return { payload, appId: row.app.id };
}

// ---- Rendering ----

const RED = '#dc2626';
const GREEN = '#16a34a';

function humanDowntime(seconds: number | null): string {
  if (seconds == null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function humanSilence(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Platform-level alert: the monitoring itself stopped producing runs. There is
 * no application, check or run to link to — that is precisely the problem —
 * so this renders from the silence measurement alone.
 */
function renderMonitoringBody(type: ChannelType, p: MonitoringAlertWebhookPayload, publicUrl: string): unknown {
  const stalled = p.event === 'monitoring.stalled';
  const title = stalled
    ? 'MONITORING STALLED — no checks are running'
    : 'MONITORING RESUMED — checks are running again';
  const detail = stalled
    ? `No check has completed in ${humanSilence(p.monitoring.silentForSeconds)} (threshold ${p.monitoring.thresholdMinutes}m). Vyzus itself may be down — verify the worker.`
    : `Checks are completing again after ${humanSilence(p.monitoring.silentForSeconds)} of silence.`;
  const lastRun = p.monitoring.lastRunAt ?? 'never';

  if (type === 'slack') {
    return {
      attachments: [
        {
          color: stalled ? RED : GREEN,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: title } },
            { type: 'section', text: { type: 'mrkdwn', text: detail } },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Last run:*\n${lastRun}` },
                { type: 'mrkdwn', text: `*Dashboard:*\n<${publicUrl}|Open Vyzus>` },
              ],
            },
          ],
        },
      ],
    };
  }

  if (type === 'discord') {
    return {
      embeds: [
        {
          title,
          url: publicUrl,
          color: stalled ? 0xdc2626 : 0x16a34a,
          fields: [
            { name: 'Detail', value: detail, inline: false },
            { name: 'Last run', value: lastRun, inline: true },
            { name: 'Threshold', value: `${p.monitoring.thresholdMinutes}m`, inline: true },
          ],
          timestamp: p.timestamp,
        },
      ],
    };
  }

  return p;
}

/** Render the outbound HTTP body for a channel type (04-api-spec). */
export function renderAlertBody(type: ChannelType, p: AlertWebhookPayload, publicUrl: string): unknown {
  if (isMonitoringAlert(p)) return renderMonitoringBody(type, p, publicUrl);
  const down = p.event === 'check.down';
  // No emoji in the title: Slack and Discord already colour the attachment /
  // embed from the `color` field below, so a status word carries the same
  // signal without depending on emoji rendering (and stays readable in
  // notification previews, email digests, and log lines).
  const title = down
    ? `DOWN: ${p.application.name} — ${p.check.name}`
    : `RECOVERED: ${p.application.name} — ${p.check.name}`;
  const runUrl = `${publicUrl}/runs/${p.run.id}`;
  const appUrl = `${publicUrl}/apps/${p.application.id}`;

  if (type === 'slack') {
    const fields = [
      { type: 'mrkdwn', text: `*Application:*\n<${appUrl}|${p.application.name}>` },
      { type: 'mrkdwn', text: `*Check:*\n${p.check.name} (${p.check.type})` },
      { type: 'mrkdwn', text: `*Run:*\n<${runUrl}|${p.run.status}>` },
      down
        ? { type: 'mrkdwn', text: `*Error:*\n${p.run.errorMessage ?? 'n/a'}` }
        : { type: 'mrkdwn', text: `*Downtime:*\n${humanDowntime(p.incident.downtimeSeconds)}` },
    ];
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: title } },
      { type: 'section', fields },
    ];
    if (p.run.screenshotUrl) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `<${p.run.screenshotUrl}|View screenshot>` },
      });
    }
    return { attachments: [{ color: down ? RED : GREEN, blocks }] };
  }

  if (type === 'discord') {
    const fields = [
      { name: 'Application', value: `[${p.application.name}](${appUrl})`, inline: true },
      { name: 'Check', value: `${p.check.name} (${p.check.type})`, inline: true },
      { name: 'Run', value: `[${p.run.status}](${runUrl})`, inline: true },
      down
        ? { name: 'Error', value: p.run.errorMessage?.slice(0, 1000) ?? 'n/a', inline: false }
        : { name: 'Downtime', value: humanDowntime(p.incident.downtimeSeconds), inline: true },
    ];
    return {
      embeds: [
        {
          title,
          url: appUrl,
          color: down ? 0xdc2626 : 0x16a34a,
          fields,
          timestamp: p.timestamp,
          ...(p.run.screenshotUrl ? { image: { url: p.run.screenshotUrl } } : {}),
        },
      ],
    };
  }

  // Generic webhook receives the raw shared payload.
  return p;
}

export function hmacSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// ---- Delivery ----

export interface DeliveryOutcome {
  ok: boolean;
  attempts: number;
  responseCode: number | null;
}

/**
 * POST the rendered body to the channel URL with `maxAttempts` tries and
 * exponential backoff (base × 2^n). Generic webhooks with a secret get an
 * `X-Vyzus-Signature: <hmac-sha256 hex>` header over the exact body bytes.
 */
export async function deliverToChannel(
  channel: Pick<AlertChannelRow, 'type' | 'config'>,
  payload: AlertWebhookPayload,
  publicUrl: string,
  opts: { maxAttempts?: number; backoffBaseMs?: number; timeoutMs?: number } = {},
): Promise<DeliveryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const body = JSON.stringify(renderAlertBody(channel.type, payload, publicUrl));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (channel.type === 'webhook' && channel.config.secret) {
    headers[ALERT_SIGNATURE_HEADER] = hmacSignature(channel.config.secret, body);
  }

  let responseCode: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(channel.config.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      responseCode = res.status;
      if (res.ok) return { ok: true, attempts: attempt, responseCode };
    } catch {
      responseCode = null; // network error / timeout
    }
    if (attempt < maxAttempts) await sleep(backoffBaseMs * 2 ** (attempt - 1));
  }
  return { ok: false, attempts: maxAttempts, responseCode };
}

// ---- Queue consumer ----

export interface AlerterOptions {
  connection: Redis;
  db: Database;
  publicUrl: string;
  log: FastifyBaseLogger;
  /** Test override for the retry backoff base. */
  backoffBaseMs?: number;
}

export function startAlerter(options: AlerterOptions): Worker {
  const { connection, db, publicUrl, log } = options;

  const worker = new Worker(
    QUEUE_NAMES.alerts,
    async (job) => {
      const parsed = alertJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ jobId: job.id, data: job.data }, 'malformed alerts job — dropping');
        return;
      }
      const data = parsed.data;
      const event = data.event;

      // Two producers. A check alert resolves an incident into a payload and
      // targets that application's channels; a monitoring alert has no
      // application at all, so it goes to every all_apps channel — those are
      // the ones subscribed to the platform rather than to one target.
      let payload: AlertWebhookPayload;
      let incidentId: string | null = null;
      let appId: string | null = null;

      if ('incidentId' in data) {
        const built = await buildAlertPayload(db, data.incidentId, data.event, publicUrl);
        if (!built) {
          log.warn({ incidentId: data.incidentId }, 'alert for unknown incident — dropping');
          return;
        }
        payload = built.payload;
        incidentId = data.incidentId;
        appId = built.appId;
      } else {
        payload = {
          event: data.event === 'stalled' ? 'monitoring.stalled' : 'monitoring.resumed',
          monitoring: {
            lastRunAt: data.lastRunAt,
            silentForSeconds: data.silentForSeconds,
            thresholdMinutes: data.thresholdMinutes,
          },
          timestamp: new Date().toISOString(),
        };
      }

      const channelRows =
        appId === null
          ? await db
              .select({ channel: alertChannels })
              .from(alertChannels)
              .where(and(eq(alertChannels.enabled, true), eq(alertChannels.allApps, true)))
          : // Channels: enabled AND (all_apps OR explicitly bound to this app).
            await db
              .selectDistinct({ channel: alertChannels })
              .from(alertChannels)
              .leftJoin(
                appAlertChannels,
                and(eq(appAlertChannels.channelId, alertChannels.id), eq(appAlertChannels.appId, appId)),
              )
              .where(
                and(
                  eq(alertChannels.enabled, true),
                  or(eq(alertChannels.allApps, true), eq(appAlertChannels.appId, appId)),
                ),
              );

      for (const { channel } of channelRows) {
        const outcome = await deliverToChannel(channel, payload, publicUrl, {
          ...(options.backoffBaseMs !== undefined ? { backoffBaseMs: options.backoffBaseMs } : {}),
        });
        await db.insert(alertDeliveries).values({
          incidentId,
          channelId: channel.id,
          event,
          status: outcome.ok ? 'sent' : 'failed',
          attempts: outcome.attempts,
          responseCode: outcome.responseCode,
        });
        log.info(
          { incidentId, event, channelId: channel.id, ok: outcome.ok, attempts: outcome.attempts },
          'alert delivery finished',
        );
      }
    },
    { connection: connection.duplicate({ maxRetriesPerRequest: null }), concurrency: 4 },
  );

  worker.on('error', (err) => log.error({ err }, 'alerter worker error'));
  return worker;
}

/** Sample payload used by POST /channels/:id/test. */
export function sampleAlertPayload(publicUrl: string): AlertWebhookPayload {
  const now = new Date();
  return {
    event: 'check.down',
    application: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Vyzus test',
      landingUrl: publicUrl,
    },
    check: { id: '00000000-0000-4000-8000-000000000002', name: 'Test check', type: 'uptime' },
    incident: {
      id: '00000000-0000-4000-8000-000000000003',
      openedAt: now.toISOString(),
      resolvedAt: null,
      downtimeSeconds: null,
    },
    run: {
      id: '00000000-0000-4000-8000-000000000004',
      status: 'failed',
      errorMessage: 'This is a test alert from Vyzus — everything is fine.',
      screenshotUrl: null,
    },
    timestamp: now.toISOString(),
  };
}
