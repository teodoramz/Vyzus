// Alert dispatcher (Phase 5). A BullMQ Worker inside the API process consumes
// the `alerts` queue (fed by the worker's incident state machine), renders the
// payload per channel type (Slack Block Kit / Discord embed / generic JSON with
// HMAC signature), POSTs with 3-attempt exponential backoff, and logs every
// outcome in `alert_deliveries`. Channel selection honours `all_apps` and the
// `app_alert_channels` bindings.
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, gt, lte, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  QUEUE_NAMES,
  ALERT_SIGNATURE_HEADER,
  alertJobPayloadSchema,
  isMonitoringAlert,
  isEmailChannelConfig,
  mergeChannelSecrets,
  type ChannelSecrets,
  activeMaintenanceWindow,
  findFailingAncestor,
  type AlertWebhookPayload,
  type MonitoringAlertWebhookPayload,
  type EmailChannelConfig,
  type AlertEvent,
  type ChannelType,
} from '@vyzus/shared';
import type { Database } from '../db/index.js';
import { decryptJson } from '../lib/crypto.js';
import { deriveAppStatus } from '../lib/queries.js';
import {
  alertChannels,
  alertDeliveries,
  appAlertChannels,
  applications,
  checks,
  incidents,
  maintenanceWindows,
  runs,
  type AlertChannelRow,
  type CheckRow,
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

/**
 * Email subject + body. Rendered for both payload variants — a check alert and a
 * platform `monitoring.stalled`/`resumed` — because the alerter delivers both to
 * every matching channel, and an email renderer that only understood check
 * alerts would throw on the one telling you the monitoring itself stopped.
 *
 * Both a plain-text and an HTML part: text-only is unreadable once it carries a
 * screenshot link and timings, HTML-only breaks in terminal mail clients.
 */
export function renderEmailBody(
  p: AlertWebhookPayload,
  publicUrl: string,
): { subject: string; text: string; html: string } {
  const esc = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  if (isMonitoringAlert(p)) {
    const stalled = p.event === 'monitoring.stalled';
    const subject = stalled ? '[Vyzus] MONITORING STALLED — no checks are running' : '[Vyzus] Monitoring resumed';
    const detail = stalled
      ? `No check has completed anywhere in ${humanSilence(p.monitoring.silentForSeconds)} (threshold ${p.monitoring.thresholdMinutes}m). Vyzus itself may be down — verify the worker.`
      : `Checks are completing again after ${humanSilence(p.monitoring.silentForSeconds)} of silence.`;
    const lastRun = p.monitoring.lastRunAt ?? 'never';
    const text = [detail, '', `Last run: ${lastRun}`, `Dashboard: ${publicUrl}`].join('\n');
    const html = [
      `<h2 style="color:${stalled ? RED : GREEN}">${esc(stalled ? 'Monitoring stalled' : 'Monitoring resumed')}</h2>`,
      `<p>${esc(detail)}</p>`,
      `<p><strong>Last run:</strong> ${esc(lastRun)}<br>`,
      `<a href="${esc(publicUrl)}">Open Vyzus</a></p>`,
    ].join('');
    return { subject, text, html };
  }

  const down = p.event === 'check.down';
  const subject = down
    ? `[Vyzus] DOWN: ${p.application.name} — ${p.check.name}`
    : `[Vyzus] Recovered: ${p.application.name} — ${p.check.name}`;
  const appUrl = `${publicUrl}/apps/${p.application.id}`;
  const runUrl = `${publicUrl}/runs/${p.run.id}`;
  const detail = down
    ? `Error: ${p.run.errorMessage ?? 'n/a'}`
    : `Downtime: ${humanDowntime(p.incident.downtimeSeconds)}`;

  const text = [
    `${down ? 'DOWN' : 'RECOVERED'}: ${p.application.name} — ${p.check.name} (${p.check.type})`,
    '',
    detail,
    `Run status: ${p.run.status}`,
    '',
    `Application: ${appUrl}`,
    `Run: ${runUrl}`,
    ...(p.run.screenshotUrl ? [`Screenshot: ${p.run.screenshotUrl}`] : []),
  ].join('\n');

  const html = [
    `<h2 style="color:${down ? RED : GREEN}">${esc(down ? 'DOWN' : 'Recovered')}: ${esc(p.application.name)}</h2>`,
    `<p><strong>Check:</strong> ${esc(p.check.name)} (${esc(p.check.type)})<br>`,
    `<strong>${down ? 'Error' : 'Downtime'}:</strong> ${esc(down ? (p.run.errorMessage ?? 'n/a') : humanDowntime(p.incident.downtimeSeconds))}<br>`,
    `<strong>Run status:</strong> ${esc(p.run.status)}</p>`,
    `<p><a href="${esc(appUrl)}">Application</a> &middot; <a href="${esc(runUrl)}">Run detail</a></p>`,
    ...(p.run.screenshotUrl
      ? [`<p><img src="${esc(p.run.screenshotUrl)}" alt="Screenshot" style="max-width:100%"></p>`]
      : []),
  ].join('');

  return { subject, text, html };
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
  /**
   * Decrypted credentials, or null when the channel has none. Required rather
   * than optional so a new call site cannot silently deliver unsigned.
   */
  secrets: ChannelSecrets | null,
  payload: AlertWebhookPayload,
  publicUrl: string,
  opts: { maxAttempts?: number; backoffBaseMs?: number; timeoutMs?: number } = {},
): Promise<DeliveryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Email is SMTP, not an HTTP POST, so it needs its own transport — but it
  // reuses the same retry/backoff loop and reports the same DeliveryOutcome, so
  // `alert_deliveries` logging upstream stays identical for every channel type.
  // Credentials live encrypted in their own column; rejoin them only here, at
  // the point of use, so they exist in memory for as short a span as possible.
  const full = mergeChannelSecrets(channel.config, secrets);

  if (isEmailChannelConfig(full)) {
    return deliverByEmail(full, payload, publicUrl, { maxAttempts, backoffBaseMs, timeoutMs });
  }
  const config = full;

  const body = JSON.stringify(renderAlertBody(channel.type, payload, publicUrl));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (channel.type === 'webhook' && config.secret) {
    headers[ALERT_SIGNATURE_HEADER] = hmacSignature(config.secret, body);
  }

  let responseCode: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(config.url, {
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

/**
 * SMTP delivery. `responseCode` stays null throughout: SMTP has reply codes but
 * nodemailer does not surface them uniformly, and inventing an HTTP-shaped
 * number would be worse than admitting there isn't one.
 */
async function deliverByEmail(
  config: EmailChannelConfig,
  payload: AlertWebhookPayload,
  publicUrl: string,
  opts: { maxAttempts: number; backoffBaseMs: number; timeoutMs: number },
): Promise<DeliveryOutcome> {
  const { subject, text, html } = renderEmailBody(payload, publicUrl);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.username && config.password ? { auth: { user: config.username, pass: config.password } } : {}),
    connectionTimeout: opts.timeoutMs,
    greetingTimeout: opts.timeoutMs,
    socketTimeout: opts.timeoutMs,
  });

  try {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        await transporter.sendMail({ from: config.from, to: config.to.join(', '), subject, text, html });
        return { ok: true, attempts: attempt, responseCode: null };
      } catch {
        // Deliberately swallowed: the message can carry the SMTP password in a
        // connection string, and this outcome is written to alert_deliveries.
        if (attempt < opts.maxAttempts) await sleep(opts.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    return { ok: false, attempts: opts.maxAttempts, responseCode: null };
  } finally {
    transporter.close();
  }
}

// ---- Queue consumer ----

export interface AlerterOptions {
  connection: Redis;
  db: Database;
  publicUrl: string;
  /** Hex AES key for the per-channel credential blobs. */
  encryptionKey: string;
  log: FastifyBaseLogger;
  /** Test override for the retry backoff base. */
  backoffBaseMs?: number;
}

/**
 * The nearest ancestor application that is currently DOWN, or null.
 *
 * Statuses are derived, not stored, so this loads every application with its
 * checks and derives them — cheap at the scale this runs (once per alert, not
 * per run) and avoids a denormalised status column that could go stale.
 */
async function findFailingUpstream(db: Database, appId: string): Promise<{ name: string } | null> {
  const rows = await db
    .select({
      id: applications.id,
      name: applications.name,
      parentAppId: applications.parentAppId,
      enabled: applications.enabled,
      check: checks,
    })
    .from(applications)
    .leftJoin(checks, eq(checks.appId, applications.id));

  const byId = new Map<string, { id: string; name: string; parentAppId: string | null; status: string }>();
  const checksByApp = new Map<string, CheckRow[]>();
  for (const row of rows) {
    if (row.check) {
      const list = checksByApp.get(row.id) ?? [];
      list.push(row.check);
      checksByApp.set(row.id, list);
    }
    if (!byId.has(row.id)) {
      byId.set(row.id, { id: row.id, name: row.name, parentAppId: row.parentAppId, status: 'UNKNOWN' });
    }
  }
  for (const [id, node] of byId) {
    const row = rows.find((r) => r.id === id)!;
    node.status = deriveAppStatus(row.enabled, checksByApp.get(id) ?? []);
  }

  return findFailingAncestor(appId, byId);
}

export function startAlerter(options: AlerterOptions): Worker {
  const { connection, db, publicUrl, encryptionKey, log } = options;

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

      // Planned-work suppression. Checked here, at dispatch, not at the
      // scheduler: the check still ran and the incident still opened, so the
      // history is intact and the dead-man's switch (which watches for runs
      // stopping) sees nothing unusual — only the notification is withheld.
      //
      // Platform alerts are never suppressed: "the monitoring itself stopped"
      // is exactly the thing you still want to hear during a deploy.
      if (appId !== null) {
        const now = new Date();
        const windows = await db
          .select({
            appId: maintenanceWindows.appId,
            startsAt: maintenanceWindows.startsAt,
            endsAt: maintenanceWindows.endsAt,
            reason: maintenanceWindows.reason,
          })
          .from(maintenanceWindows)
          .where(and(lte(maintenanceWindows.startsAt, now), gt(maintenanceWindows.endsAt, now)));
        const active = activeMaintenanceWindow(windows, appId, now);
        if (active) {
          log.info(
            { incidentId, event, appId, reason: active.reason },
            'alert suppressed by an active maintenance window',
          );
          return;
        }

        // Dependency suppression. One dead upstream should page once, not once
        // per service behind it — forty alerts describing a single fault is how
        // people learn to ignore the channel.
        //
        // Only `down` is suppressed. A recovery still goes out: having been told
        // the upstream failed, you want to hear that this service came back,
        // and a silent recovery leaves the incident looking open forever.
        if (event === 'down') {
          const failing = await findFailingUpstream(db, appId);
          if (failing) {
            log.info(
              { incidentId, event, appId, upstream: failing.name },
              'alert suppressed — an upstream application is down',
            );
            return;
          }
        }
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
        // An unreadable blob — a rotated key, a truncated column — must cost
        // this one channel, not the whole incident: throwing here would abandon
        // every channel after it with no delivery row to show for it.
        let secrets: ChannelSecrets | null = null;
        try {
          if (channel.secretsEnc) secrets = decryptJson<ChannelSecrets>(channel.secretsEnc, encryptionKey);
        } catch {
          log.error({ channelId: channel.id }, 'unreadable channel credentials — delivering without them');
        }
        const outcome = await deliverToChannel(channel, secrets, payload, publicUrl, {
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
