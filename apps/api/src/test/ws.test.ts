// WS plugin: token-gated upgrade + Redis pub/sub → client fan-out.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SignJWT } from 'jose';
import type { AddressInfo } from 'node:net';
import { RUN_FINISHED_CHANNEL } from '@vyzus/shared';
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

let ctx: TestContext;
let baseUrl: string;

beforeAll(async () => {
  ctx = await buildTestApp();
  await resetDb(ctx);
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = ctx.app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeTestApp(ctx);
});

function nextMessage(socket: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(t);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

describe('GET /ws', () => {
  it('closes the socket for a missing/invalid token', async () => {
    const noToken = new WebSocket(`${baseUrl}/ws`);
    const code1 = await new Promise<number>((resolve) => noToken.on('close', resolve));
    expect(code1).toBe(4401);

    const badToken = new WebSocket(`${baseUrl}/ws?token=garbage`);
    const code2 = await new Promise<number>((resolve) => badToken.on('close', resolve));
    expect(code2).toBe(4401);
  });

  // A socket authorized once and never again outlives every permission it was
  // granted under — a demoted or unassigned user would keep receiving live
  // events for as long as the connection stayed up.
  it('closes an authenticated socket when its access token expires', async () => {
    const { body } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminId = (body as { user: { id: string } }).user.id;
    const shortLived = await new SignJWT({ role: 'admin', email: ADMIN_EMAIL })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(adminId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 1)
      .sign(new TextEncoder().encode(makeTestConfig().JWT_SECRET));

    const socket = new WebSocket(`${baseUrl}/ws?token=${shortLived}`);
    await new Promise<void>((resolve) => socket.on('open', resolve));

    const code = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket outlived its token')), 5000);
      socket.on('close', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code).toBe(4401);
  });

  it('forwards run.finished pub/sub events to authenticated clients', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const socket = new WebSocket(`${baseUrl}/ws?token=${accessToken}`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    // Give the server a beat to finish token verification before publishing.
    await new Promise((r) => setTimeout(r, 300));

    const event = {
      type: 'run.finished',
      appId: '11111111-1111-4111-8111-111111111111',
      checkId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      status: 'passed',
      durationMs: 1234,
      hasScreenshot: true,
    };
    const waiter = nextMessage(socket);
    await ctx.redis.publish(RUN_FINISHED_CHANNEL, JSON.stringify(event));
    const received = await waiter;
    expect(received).toEqual(event);
    socket.close();
  });

  it('drops malformed pub/sub messages instead of forwarding them', async () => {
    const { accessToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const socket = new WebSocket(`${baseUrl}/ws?token=${accessToken}`);
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    await new Promise((r) => setTimeout(r, 300));

    await ctx.redis.publish(RUN_FINISHED_CHANNEL, 'not-json');
    await ctx.redis.publish(RUN_FINISHED_CHANNEL, JSON.stringify({ type: 'run.finished' })); // fails schema

    const good = {
      type: 'run.finished',
      appId: '11111111-1111-4111-8111-111111111111',
      checkId: '22222222-2222-4222-8222-222222222222',
      runId: '44444444-4444-4444-8444-444444444444',
      status: 'failed',
      durationMs: 10,
      hasScreenshot: false,
    };
    const waiter = nextMessage(socket);
    await ctx.redis.publish(RUN_FINISHED_CHANNEL, JSON.stringify(good));
    const received = await waiter; // first thing that arrives is the valid one
    expect(received).toEqual(good);
    socket.close();
  });

  it('does not forward events for apps a connected viewer has no access to', async () => {
    const { accessToken: adminToken } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const appRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/apps',
      headers: authHeader(adminToken),
      payload: { name: 'Shop', landingUrl: 'https://shop.example.com' },
    });
    const app = appRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(adminToken),
      payload: { email: 'ws-viewer@example.com', password: 'password123', role: 'viewer' },
    });
    // Deliberately do NOT assign `app` to this viewer.
    const { accessToken: viewerToken } = await login(ctx.app, 'ws-viewer@example.com', 'password123');

    const adminSocket = new WebSocket(`${baseUrl}/ws?token=${adminToken}`);
    const viewerSocket = new WebSocket(`${baseUrl}/ws?token=${viewerToken}`);
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        adminSocket.on('open', resolve);
        adminSocket.on('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        viewerSocket.on('open', resolve);
        viewerSocket.on('error', reject);
      }),
    ]);
    await new Promise((r) => setTimeout(r, 300));

    const event = {
      type: 'run.finished',
      appId: app.id,
      checkId: app.checks[0].id,
      runId: '55555555-5555-4555-8555-555555555555',
      status: 'passed',
      durationMs: 42,
      hasScreenshot: false,
    };

    const adminWaiter = nextMessage(adminSocket);
    const viewerGotSomething = new Promise<'message'>((resolve) =>
      viewerSocket.once('message', () => resolve('message')),
    );
    const viewerTimedOut = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000));

    await ctx.redis.publish(RUN_FINISHED_CHANNEL, JSON.stringify(event));

    expect(await adminWaiter).toEqual(event); // admin (unrestricted) still receives it
    expect(await Promise.race([viewerGotSomething, viewerTimedOut])).toBe('timeout'); // viewer does not

    adminSocket.close();
    viewerSocket.close();
  });
});
