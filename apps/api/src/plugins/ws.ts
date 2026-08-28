// WebSocket push (04-api-spec §WebSocket): dashboard clients connect to
// GET /ws and authenticate with the access token in the Sec-WebSocket-Protocol
// header; the API subscribes to the worker's Redis pub/sub channels and fans
// every event out to all authenticated sockets.
// The worker publishes messages already shaped as WS events, so forwarding is
// a straight pass-through (validated against the shared schema first).
//
// Phase 7: on any run.finished / incident.* event the API also emits a
// `stats.updated` event (recomputed { up, down, openIncidents }), throttled to
// at most ~1/s so a burst of runs doesn't hammer clients.
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import {
  RUN_FINISHED_CHANNEL,
  INCIDENT_OPENED_CHANNEL,
  INCIDENT_RESOLVED_CHANNEL,
  wsEventSchema,
  type WsEvent,
  type UserRole,
} from '@vyzus/shared';
import { userAppAccess } from '../db/schema.js';
import { computeAppCounts, countOpenIncidents } from '../lib/stats.js';

const CHANNELS = [RUN_FINISHED_CHANNEL, INCIDENT_OPENED_CHANNEL, INCIDENT_RESOLVED_CHANNEL];
const STATS_THROTTLE_MS = 1_000;

/**
 * The access token rides here rather than in the query string, which nginx and
 * every proxy in front of it log. A browser cannot set headers on a WebSocket,
 * so the subprotocol list is the only client-controlled header available.
 */
const AUTH_PROTOCOL_PREFIX = 'vyzus.auth.';

/**
 * Offered alongside the auth entry and echoed back as the negotiated protocol.
 * The handshake must name one of the offered protocols or the browser fails the
 * connection; naming this one keeps the token out of the response headers.
 */
const WS_PROTOCOL = 'vyzus.v1';

/** The access token from a Sec-WebSocket-Protocol list, or null. */
function tokenFromProtocols(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const entries = (Array.isArray(header) ? header.join(',') : header).split(',');
  for (const entry of entries) {
    const value = entry.trim();
    if (value.startsWith(AUTH_PROTOCOL_PREFIX)) {
      const token = value.slice(AUTH_PROTOCOL_PREFIX.length);
      return token.length > 0 ? token : null;
    }
  }
  return null;
}

interface WsClient {
  role: UserRole;
  /** Accessible app ids for a viewer; null = unrestricted (admin/editor). Cached
   * at connect time — an assignment change takes effect on the next reconnect,
   * same as any other JWT-claims-derived permission in this app. */
  allowedAppIds: Set<string> | null;
  /** Fires at the access token's own expiry; see the close scheduling below. */
  expiryTimer: NodeJS.Timeout;
}

/** run.finished/incident.* carry a single appId; stats.updated is global. */
function eventAppId(event: WsEvent): string | null {
  return event.type === 'stats.updated' ? null : event.appId;
}

export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket, {
    options: {
      // Never echo the entry carrying the token.
      handleProtocols: (protocols: Set<string>) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    },
  });

  const clients = new Map<WebSocket, WsClient>();

  const broadcast = (event: WsEvent): void => {
    const data = JSON.stringify(event);
    const appId = eventAppId(event);
    for (const [socket, client] of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      // Aggregate platform-wide counts aren't meaningful (or scoped) for a
      // viewer restricted to a handful of apps — skip rather than compute a
      // per-viewer variant.
      if (event.type === 'stats.updated' && client.role === 'viewer') continue;
      if (appId && client.allowedAppIds && !client.allowedAppIds.has(appId)) continue;
      socket.send(data);
    }
  };

  // Throttled stats.updated (leading + trailing edge, max ~1/s).
  let lastStatsAt = 0;
  let statsTimer: NodeJS.Timeout | null = null;
  const emitStats = async (): Promise<void> => {
    try {
      const [counts, openIncidents] = await Promise.all([computeAppCounts(app.db), countOpenIncidents(app.db)]);
      broadcast({ type: 'stats.updated', up: counts.up, down: counts.down, openIncidents });
    } catch (err) {
      app.log.warn({ err }, 'stats.updated computation failed');
    }
  };
  const scheduleStats = (): void => {
    const elapsed = Date.now() - lastStatsAt;
    if (elapsed >= STATS_THROTTLE_MS) {
      lastStatsAt = Date.now();
      void emitStats();
    } else if (!statsTimer) {
      statsTimer = setTimeout(() => {
        statsTimer = null;
        lastStatsAt = Date.now();
        void emitStats();
      }, STATS_THROTTLE_MS - elapsed);
      statsTimer.unref();
    }
  };

  // Dedicated subscriber connection (a subscribing Redis connection cannot run
  // regular commands).
  const sub: Redis = app.redis.duplicate();
  await sub.subscribe(...CHANNELS);
  sub.on('message', (_channel: string, message: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      app.log.warn({ message }, 'unparseable pub/sub message dropped');
      return;
    }
    const event = wsEventSchema.safeParse(parsed);
    if (!event.success) {
      app.log.warn({ message }, 'pub/sub message failed WS schema — dropped');
      return;
    }
    broadcast(event.data);
    // Any run/incident transition can change the header aggregates.
    scheduleStats();
  });

  /** Forget a socket and cancel its pending expiry close. */
  const drop = (socket: WebSocket): void => {
    const client = clients.get(socket);
    if (client) clearTimeout(client.expiryTimer);
    clients.delete(socket);
  };

  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    if (token === null) {
      socket.close(4401, 'missing token');
      return;
    }
    // Before the async work below: a socket closing mid-lookup would otherwise
    // never be cleaned up.
    socket.on('close', () => drop(socket));

    void app.tokens
      .verifyAccessToken(token)
      .then(async (claims) => {
        let allowedAppIds: Set<string> | null = null;
        if (claims.role === 'viewer') {
          const rows = await app.db
            .select({ appId: userAppAccess.appId })
            .from(userAppAccess)
            .where(eq(userAppAccess.userId, claims.sub));
          allowedAppIds = new Set(rows.map((r) => r.appId));
        }
        if (socket.readyState !== socket.OPEN) return;

        // Authorization is checked once at connect, so without this a demoted
        // or unassigned user keeps receiving events for the life of the
        // connection — indefinitely on a busy platform. Closing at the token's
        // expiry bounds that to one token lifetime; the client reconnects and
        // is re-authorized from scratch.
        const ttl = claims.expiresAt.getTime() - Date.now();
        const expiryTimer = setTimeout(
          () => {
            drop(socket);
            socket.close(4401, 'token expired');
          },
          Math.max(0, ttl),
        );
        expiryTimer.unref(); // never hold the event loop open at shutdown

        clients.set(socket, { role: claims.role, allowedAppIds, expiryTimer });
      })
      .catch(() => {
        socket.close(4401, 'invalid token');
      });
  });

  app.addHook('onClose', async () => {
    if (statsTimer) clearTimeout(statsTimer);
    for (const [socket, client] of clients) {
      clearTimeout(client.expiryTimer);
      socket.close(1001, 'server shutting down');
    }
    clients.clear();
    sub.disconnect();
  });
}
