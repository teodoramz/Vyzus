// Phase 5 acceptance: alert rendering, HMAC signature, 3-attempt backoff, and
// alert_deliveries logging — exercised against a local HTTP listener.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { QUEUE_NAMES, ALERT_SIGNATURE_HEADER, type AlertJobPayload, type Channel } from '@vyzus/shared';
import {
  alertChannels,
  alertDeliveries,
  maintenanceWindows,
  applications,
  appAlertChannels,
  checks,
  incidents,
  runs,
} from '../db/schema.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { startAlerter, renderAlertBody, sampleAlertPayload } from '../services/alerter.js';
import {
  buildTestApp,
  closeTestApp,
  resetDb,
  login,
  authHeader,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  makeTestConfig,
  type TestContext,
} from './helpers.js';

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Listener {
  url: string;
  requests: CapturedRequest[];
  /** Per-path behaviour: how many times to fail (500) before succeeding. */
  failFirst(path: string, times: number): void;
  close(): Promise<void>;
}

function startListener(): Promise<Listener> {
  const requests: CapturedRequest[] = [];
  const failCounts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push({ path: req.url ?? '/', headers: req.headers, body });
      const remaining = failCounts.get(req.url ?? '/') ?? 0;
      if (remaining > 0) {
        failCounts.set(req.url ?? '/', remaining - 1);
        res.writeHead(500).end('boom');
      } else {
        res.writeHead(200).end('ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        failFirst: (path, times) => failCounts.set(path, times),
        close: () => new Promise((res2, rej) => server.close((err) => (err ? rej(err) : res2()))),
      });
    });
  });
}

let ctx: TestContext;
let listener: Listener;

beforeAll(async () => {
  ctx = await buildTestApp();
  listener = await startListener();
});

afterAll(async () => {
  await listener.close();
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  listener.requests.length = 0;
  const q = new Queue(QUEUE_NAMES.alerts, { connection: ctx.redis });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
});

/** Seed app+check+failed run+open incident; returns ids. */
async function seedIncident() {
  const [app] = await ctx.dbHandle.db
    .insert(applications)
    .values({ name: 'Shop', landingUrl: 'https://shop.example.com', tags: [] })
    .returning();
  const [check] = await ctx.dbHandle.db
    .insert(checks)
    .values({
      appId: app!.id,
      type: 'uptime',
      name: 'Landing uptime',
      intervalMinutes: 5,
      config: {
        mode: 'http',
        expectedStatus: 200,
        maxDurationMs: 0,
        visualDiffPercent: 0,
        certExpiryWarningDays: 0,
        screenshot: 'on_failure',
      },
    })
    .returning();
  const [run] = await ctx.dbHandle.db
    .insert(runs)
    .values({
      checkId: check!.id,
      status: 'failed',
      trigger: 'schedule',
      startedAt: new Date(),
      durationMs: 1234,
      errorMessage: 'Expected HTTP 200, got 503',
      screenshotPath: `${app!.id}/some-run/screenshot.png`,
    })
    .returning();
  const [incident] = await ctx.dbHandle.db
    .insert(incidents)
    .values({ checkId: check!.id, openedAt: new Date(), openingRunId: run!.id })
    .returning();
  return { app: app!, check: check!, run: run!, incident: incident! };
}

async function enqueueAndProcess(payload: AlertJobPayload): Promise<void> {
  const alerter = startAlerter({
    connection: ctx.redis,
    db: ctx.dbHandle.db,
    publicUrl: 'http://localhost:8080',
    encryptionKey: makeTestConfig().ENCRYPTION_KEY,
    log: pino({ level: 'silent' }),
    backoffBaseMs: 10, // fast retries in tests
  });
  await alerter.waitUntilReady();
  const q = new Queue(QUEUE_NAMES.alerts, { connection: ctx.redis });
  await q.add('test', payload, { removeOnComplete: true, removeOnFail: true });
  // Wait until deliveries are logged (max ~5 s).
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await ctx.dbHandle.db.select().from(alertDeliveries);
    const channels = await ctx.dbHandle.db.select().from(alertChannels);
    if (rows.length >= channels.filter((c) => c.enabled).length || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await q.close();
  await alerter.close();
}

describe('renderAlertBody', () => {
  const payload = sampleAlertPayload('http://localhost:8080');

  it('renders Slack Block Kit with a red attachment for down', () => {
    const body = renderAlertBody('slack', payload, 'http://localhost:8080') as {
      attachments: { color: string; blocks: { type: string }[] }[];
    };
    expect(body.attachments[0]!.color).toBe('#dc2626');
    expect(body.attachments[0]!.blocks.some((b) => b.type === 'header')).toBe(true);
  });

  it('renders a Discord embed with fields', () => {
    const body = renderAlertBody('discord', payload, 'http://localhost:8080') as {
      embeds: { color: number; fields: unknown[]; title: string }[];
    };
    expect(body.embeds[0]!.color).toBe(0xdc2626);
    expect(body.embeds[0]!.title).toContain('DOWN');
    expect(body.embeds[0]!.fields.length).toBeGreaterThanOrEqual(3);
  });

  it('passes the raw shared payload to generic webhooks', () => {
    const body = renderAlertBody('webhook', payload, 'http://localhost:8080');
    expect(body).toEqual(payload);
  });
});

describe('alerter queue consumer', () => {
  it('delivers down alerts to all matching channels and logs deliveries', async () => {
    const { app, incident } = await seedIncident();
    await ctx.dbHandle.db.insert(alertChannels).values([
      { name: 'slack', type: 'slack', config: { url: `${listener.url}/slack` }, allApps: true },
      {
        name: 'hook',
        type: 'webhook',
        config: { url: `${listener.url}/hook` },
        // The signing secret lives encrypted beside the config, never in it.
        secretsEnc: encryptJson({ secret: 'tops3cret' }, makeTestConfig().ENCRYPTION_KEY),
        allApps: true,
      },
      { name: 'disabled', type: 'webhook', config: { url: `${listener.url}/disabled` }, enabled: false, allApps: true },
    ]);

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });

    const paths = listener.requests.map((r) => r.path).sort();
    expect(paths).toEqual(['/hook', '/slack']); // disabled channel skipped

    // Generic webhook: exact payload + valid HMAC over the body bytes.
    const hook = listener.requests.find((r) => r.path === '/hook')!;
    const sig = hook.headers[ALERT_SIGNATURE_HEADER.toLowerCase()] as string;
    expect(sig).toBe(createHmac('sha256', 'tops3cret').update(hook.body).digest('hex'));
    const hookBody = JSON.parse(hook.body) as Record<string, any>;
    expect(hookBody.event).toBe('check.down');
    expect(hookBody.application.id).toBe(app.id);
    expect(hookBody.run.errorMessage).toContain('503');
    expect(hookBody.run.screenshotUrl).toContain('/api/v1/runs/');

    // Slack channel got Block Kit, not the raw payload.
    const slack = listener.requests.find((r) => r.path === '/slack')!;
    expect(JSON.parse(slack.body)).toHaveProperty('attachments');

    const deliveries = await ctx.dbHandle.db.select().from(alertDeliveries);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'sent' && d.attempts === 1 && d.responseCode === 200)).toBe(true);
    expect(deliveries.every((d) => d.incidentId === incident.id && d.event === 'down')).toBe(true);
  });

  // Maintenance windows suppress the notification only. The check still ran,
  // the incident still opened — nobody was paged for planned work.
  it('suppresses delivery during an active maintenance window', async () => {
    const { app, incident } = await seedIncident();
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'hook', type: 'webhook', config: { url: `${listener.url}/hook` }, allApps: true }]);

    const now = Date.now();
    await ctx.dbHandle.db.insert(maintenanceWindows).values({
      appId: app.id,
      reason: 'deploy',
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 60_000),
    });

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });

    expect(listener.requests).toHaveLength(0);
    // No delivery row either — nothing was attempted, as opposed to failed.
    expect(await ctx.dbHandle.db.select().from(alertDeliveries)).toHaveLength(0);
  });

  it('still delivers when the window covers a different application', async () => {
    const { incident } = await seedIncident();
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'hook', type: 'webhook', config: { url: `${listener.url}/hook` }, allApps: true }]);

    const [other] = await ctx.dbHandle.db
      .insert(applications)
      .values({ name: 'Other', landingUrl: 'https://other.example.com', tags: [] })
      .returning();
    const now = Date.now();
    await ctx.dbHandle.db.insert(maintenanceWindows).values({
      appId: other!.id,
      reason: 'unrelated deploy',
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 60_000),
    });

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });
    expect(listener.requests.map((r) => r.path)).toEqual(['/hook']);
  });

  it('still delivers once the window has ended', async () => {
    const { app, incident } = await seedIncident();
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'hook', type: 'webhook', config: { url: `${listener.url}/hook` }, allApps: true }]);

    const now = Date.now();
    await ctx.dbHandle.db.insert(maintenanceWindows).values({
      appId: app.id,
      reason: 'finished deploy',
      startsAt: new Date(now - 120_000),
      endsAt: new Date(now - 60_000),
    });

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });
    expect(listener.requests.map((r) => r.path)).toEqual(['/hook']);
  });

  it('retries with backoff and logs attempts (2 failures then success)', async () => {
    const { incident } = await seedIncident();
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'flaky', type: 'webhook', config: { url: `${listener.url}/flaky` }, allApps: true }]);
    listener.failFirst('/flaky', 2);

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });

    expect(listener.requests.filter((r) => r.path === '/flaky')).toHaveLength(3);
    const [delivery] = await ctx.dbHandle.db.select().from(alertDeliveries);
    expect(delivery!.status).toBe('sent');
    expect(delivery!.attempts).toBe(3);
    expect(delivery!.responseCode).toBe(200);
  });

  it('marks a delivery failed after exhausting 3 attempts', async () => {
    const { incident } = await seedIncident();
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'dead', type: 'webhook', config: { url: `${listener.url}/dead` }, allApps: true }]);
    listener.failFirst('/dead', 99);

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });

    expect(listener.requests.filter((r) => r.path === '/dead')).toHaveLength(3);
    const [delivery] = await ctx.dbHandle.db.select().from(alertDeliveries);
    expect(delivery!.status).toBe('failed');
    expect(delivery!.attempts).toBe(3);
    expect(delivery!.responseCode).toBe(500);
  });

  it('honours app bindings when all_apps is false', async () => {
    const { app, incident } = await seedIncident();
    const [otherApp] = await ctx.dbHandle.db
      .insert(applications)
      .values({ name: 'Other', landingUrl: 'https://other.example.com', tags: [] })
      .returning();
    const [bound] = await ctx.dbHandle.db
      .insert(alertChannels)
      .values({ name: 'bound', type: 'webhook', config: { url: `${listener.url}/bound` }, allApps: false })
      .returning();
    const [unbound] = await ctx.dbHandle.db
      .insert(alertChannels)
      .values({ name: 'unbound', type: 'webhook', config: { url: `${listener.url}/unbound` }, allApps: false })
      .returning();
    await ctx.dbHandle.db.insert(appAlertChannels).values([
      { appId: app.id, channelId: bound!.id },
      { appId: otherApp!.id, channelId: unbound!.id },
    ]);

    await enqueueAndProcess({ incidentId: incident.id, event: 'down' });

    const paths = listener.requests.map((r) => r.path);
    expect(paths).toContain('/bound');
    expect(paths).not.toContain('/unbound');
  });

  it('sends a green recovery payload with downtime', async () => {
    const { check, incident } = await seedIncident();
    const [okRun] = await ctx.dbHandle.db
      .insert(runs)
      .values({ checkId: check.id, status: 'passed', trigger: 'schedule', startedAt: new Date(), durationMs: 900 })
      .returning();
    await ctx.dbHandle.db
      .update(incidents)
      .set({ resolvedAt: new Date(Date.now() + 65_000), resolvingRunId: okRun!.id })
      .where(eq(incidents.id, incident.id));
    await ctx.dbHandle.db
      .insert(alertChannels)
      .values([{ name: 'hook', type: 'webhook', config: { url: `${listener.url}/rec` }, allApps: true }]);

    await enqueueAndProcess({ incidentId: incident.id, event: 'recovered' });

    const req = listener.requests.find((r) => r.path === '/rec')!;
    const body = JSON.parse(req.body) as Record<string, any>;
    expect(body.event).toBe('check.recovered');
    expect(body.incident.resolvedAt).not.toBeNull();
    expect(body.incident.downtimeSeconds).toBeGreaterThanOrEqual(60);
    expect(body.run.status).toBe('passed');
  });
});

describe('POST /channels/:id/test', () => {
  it('sends a rendered sample alert and reports the response code', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(accessToken),
      payload: { name: 'test-hook', type: 'discord', config: { url: `${listener.url}/test-route` } },
    });
    expect(create.statusCode).toBe(201);
    const channelId = create.json().id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channelId}/test`,
      headers: authHeader(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, responseCode: 200 });

    const req = listener.requests.find((r) => r.path === '/test-route')!;
    expect(JSON.parse(req.body)).toHaveProperty('embeds'); // rendered, not raw
  });
});

// Channel credentials — the SMTP password and the webhook signing secret — are
// stored encrypted in their own column rather than in the plain jsonb config,
// so a database dump or a stray `select *` never carries a live credential.
describe('channel credential storage', () => {
  async function createChannel(payload: Record<string, unknown>): Promise<{ id: string; body: Channel }> {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: authHeader(accessToken),
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Channel;
    return { id: body.id, body };
  }

  it('keeps the signing secret out of the config column', async () => {
    const { id, body } = await createChannel({
      name: 'signed',
      type: 'webhook',
      config: { url: `${listener.url}/signed`, secret: 'tops3cret' },
    });

    const [row] = await ctx.dbHandle.db.select().from(alertChannels).where(eq(alertChannels.id, id));
    expect(JSON.stringify(row!.config)).not.toContain('tops3cret');
    expect(row!.secretsEnc).not.toBeNull();
    expect(row!.secretsEnc).not.toContain('tops3cret');
    // The response says a secret exists without ever echoing it back.
    expect(body.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain('tops3cret');
  });

  it('signs deliveries with the stored secret', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { id } = await createChannel({
      name: 'signed',
      type: 'webhook',
      config: { url: `${listener.url}/signed-delivery`, secret: 'tops3cret' },
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${id}/test`,
      headers: authHeader(accessToken),
    });

    const req = listener.requests.find((r) => r.path === '/signed-delivery')!;
    const sig = req.headers[ALERT_SIGNATURE_HEADER.toLowerCase()] as string;
    expect(sig).toBe(createHmac('sha256', 'tops3cret').update(req.body).digest('hex'));
  });

  it('keeps the existing secret when an edit submits none', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { id } = await createChannel({
      name: 'signed',
      type: 'webhook',
      config: { url: `${listener.url}/a`, secret: 'tops3cret' },
    });

    // The dashboard never receives the secret, so an unchanged edit sends the
    // config without it — that must not silently unsign the channel.
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${id}`,
      headers: authHeader(accessToken),
      payload: { config: { url: `${listener.url}/b` } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasSecret).toBe(true);

    const [row] = await ctx.dbHandle.db.select().from(alertChannels).where(eq(alertChannels.id, id));
    expect(decryptJson<{ secret?: string }>(row!.secretsEnc!, makeTestConfig().ENCRYPTION_KEY).secret).toBe(
      'tops3cret',
    );
  });

  it('replaces the secret when an edit submits a new one', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { id } = await createChannel({
      name: 'signed',
      type: 'webhook',
      config: { url: `${listener.url}/a`, secret: 'tops3cret' },
    });

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${id}`,
      headers: authHeader(accessToken),
      payload: { config: { url: `${listener.url}/a`, secret: 'rotated' } },
    });

    const [row] = await ctx.dbHandle.db.select().from(alertChannels).where(eq(alertChannels.id, id));
    expect(decryptJson<{ secret?: string }>(row!.secretsEnc!, makeTestConfig().ENCRYPTION_KEY).secret).toBe('rotated');
  });

  // A webhook secret means nothing to an SMTP transport, so carrying it across
  // a type change would leave a credential nobody can account for.
  it('drops the stored credential when the channel type changes', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { id } = await createChannel({
      name: 'signed',
      type: 'webhook',
      config: { url: `${listener.url}/a`, secret: 'tops3cret' },
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${id}`,
      headers: authHeader(accessToken),
      // `type` alone, with no config: the update schema allows it, so the drop
      // cannot depend on a config being submitted alongside.
      payload: { type: 'slack' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasSecret).toBe(false);

    const [row] = await ctx.dbHandle.db.select().from(alertChannels).where(eq(alertChannels.id, id));
    expect(row!.secretsEnc).toBeNull();
  });

  it('gives an SMTP password the same treatment', async () => {
    const { id, body } = await createChannel({
      name: 'mail',
      type: 'email',
      config: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        from: 'vyzus@example.com',
        to: ['ops@example.com'],
        username: 'vyzus',
        password: 'smtp-p4ssword',
      },
    });

    const [row] = await ctx.dbHandle.db.select().from(alertChannels).where(eq(alertChannels.id, id));
    expect(JSON.stringify(row!.config)).not.toContain('smtp-p4ssword');
    expect(row!.secretsEnc).not.toBeNull();
    expect(body.hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain('smtp-p4ssword');
  });
});
