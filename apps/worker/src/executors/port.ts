// Port executor: raw TCP connect / UDP probe, no browser involved. Supports
// domain names or IPv4/IPv6 literals, and an optional forced address family.
//
// TCP is a clean signal: the OS either completes the handshake (passed),
// actively refuses it (failed), or nothing happens within the timeout
// (timeout). UDP has no handshake, so "up" is inherently fuzzier — see
// checkUdp() below for exactly what is and isn't proven.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { evaluateCertExpiry, certExpiryMessage, type PortModeConfig } from '@vyzus/shared';
import { truncateError, type ExecutionResult } from './types.js';

export interface PortInput {
  config: PortModeConfig;
  timeoutMs: number;
}

function netFamily(family: PortModeConfig['family']): 0 | 4 | 6 {
  return family === '4' ? 4 : family === '6' ? 6 : 0;
}

function checkTcp(config: PortModeConfig, timeoutMs: number, startedAt: number): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    function finish(result: ExecutionResult): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const durationMs = Date.now() - startedAt;
      finish({
        status: 'passed',
        durationMs,
        metrics: { host: config.host, port: config.port, protocol: 'tcp', connectMs: durationMs },
        errorMessage: null,
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.once('timeout', () => {
      finish({
        status: 'timeout',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: `Connection to ${config.host}:${config.port} timed out after ${timeoutMs} ms`,
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.once('error', (err) => {
      finish({
        status: 'failed',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: truncateError(`${config.host}:${config.port} — ${err.message}`),
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.connect({ host: config.host, port: config.port, family: netFamily(config.family) });
  });
}

/**
 * TLS handshake plus certificate inspection.
 *
 * With `allowInsecureCert: false`, Node's own chain verification enforces
 * trust, expiry and hostname; a bad cert aborts the handshake and is reported
 * as `failed`. With it true the handshake always completes, and
 * `authorized`/`authorizationError` are recorded in metrics without failing
 * the check.
 */
function checkTls(config: PortModeConfig, timeoutMs: number, startedAt: number): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result: ExecutionResult): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }
    const socket = tls.connect({
      host: config.host,
      port: config.port,
      // SNI — required for hosts serving multiple certs by name. Omitted
      // for a raw IP literal: RFC 6066 disallows IP addresses as a
      // ServerName, and Node warns/ignores it there anyway.
      ...(net.isIP(config.host) ? {} : { servername: config.host }),
      // Note: tls.connect's TS type doesn't expose a `family` option the
      // way net/dgram do, so forced IPv4/IPv6 isn't honored in TLS mode —
      // DNS resolves normally. A narrow gap next to plain TCP/UDP, which do.
      rejectUnauthorized: !config.allowInsecureCert,
      timeout: timeoutMs,
    });
    socket.once('secureConnect', () => {
      const durationMs = Date.now() - startedAt;
      const cert = socket.getPeerCertificate();
      const hasCert = cert && Object.keys(cert).length > 0;
      // Floor, not round: a certificate with 13.6 days left has 13 usable days,
      // and reporting 14 would let it slip past a 14-day threshold unnoticed.
      const warnDays = config.certExpiryWarningDays;
      const validTo = hasCert && cert.valid_to ? new Date(cert.valid_to) : null;
      const verdict = validTo ? evaluateCertExpiry(validTo, warnDays) : null;
      const daysUntilExpiry = verdict?.daysUntilExpiry ?? null;
      const expiringSoon = verdict?.expiringSoon ?? false;
      finish({
        // The handshake succeeded; failing here is a deliberate early warning so
        // the renewal happens before the certificate actually lapses.
        status: expiringSoon ? 'failed' : 'passed',
        durationMs,
        metrics: {
          host: config.host,
          port: config.port,
          protocol: 'tcp',
          tls: true,
          connectMs: durationMs,
          certSubject: hasCert ? (cert.subject?.CN ?? null) : null,
          certIssuer: hasCert ? (cert.issuer?.CN ?? null) : null,
          certValidFrom: hasCert ? (cert.valid_from ?? null) : null,
          certValidTo: hasCert ? (cert.valid_to ?? null) : null,
          daysUntilExpiry,
          certExpiryWarningDays: warnDays > 0 ? warnDays : null,
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : String(socket.authorizationError ?? 'unknown'),
        },
        errorMessage: expiringSoon
          ? certExpiryMessage(`${config.host}:${config.port}`, daysUntilExpiry!, validTo, warnDays)
          : null,
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.once('timeout', () => {
      finish({
        status: 'timeout',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: `TLS connection to ${config.host}:${config.port} timed out after ${timeoutMs} ms`,
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.once('error', (err) => {
      finish({
        status: 'failed',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: truncateError(`TLS handshake with ${config.host}:${config.port} failed — ${err.message}`),
        screenshotPath: null,
        tracePath: null,
      });
    });
  });
}

/**
 * UDP has no connection handshake, so there are exactly three observable
 * outcomes, and only two of them are unambiguous:
 *  - a reply datagram arrives -> definitely open (passed)
 *  - the OS surfaces an ICMP port-unreachable as a socket error -> definitely
 *    closed (failed) — reliable on Linux for a locally-reachable host, but
 *    plenty of networks/firewalls just drop the packet instead
 *  - nothing arrives within the timeout -> genuinely inconclusive (could be
 *    open-but-silent, since many UDP services never reply to an empty probe,
 *    or filtered). Reported as passed with a note, matching how nmap treats
 *    UDP as "open|filtered" absent an explicit rejection — the alternative
 *    (failing every check against a well-behaved but silent UDP service)
 *    would be worse.
 */
async function checkUdp(config: PortModeConfig, timeoutMs: number, startedAt: number): Promise<ExecutionResult> {
  let resolvedFamily: 4 | 6;
  if (config.family === '4') resolvedFamily = 4;
  else if (config.family === '6') resolvedFamily = 6;
  else {
    try {
      const { family } = await dns.lookup(config.host);
      resolvedFamily = family === 6 ? 6 : 4;
    } catch (err) {
      return {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: truncateError(
          `DNS lookup failed for ${config.host}: ${err instanceof Error ? err.message : String(err)}`,
        ),
        screenshotPath: null,
        tracePath: null,
      };
    }
  }

  return new Promise((resolve) => {
    const socket = dgram.createSocket(resolvedFamily === 6 ? 'udp6' : 'udp4');
    let settled = false;

    function finish(result: ExecutionResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    }

    const timer = setTimeout(() => {
      finish({
        status: 'passed',
        durationMs: Date.now() - startedAt,
        metrics: {
          host: config.host,
          port: config.port,
          protocol: 'udp',
          note: 'No response within timeout and no port-unreachable error — treated as reachable (UDP cannot prove a service answered).',
        },
        errorMessage: null,
        screenshotPath: null,
        tracePath: null,
      });
    }, timeoutMs);

    socket.once('message', () => {
      finish({
        status: 'passed',
        durationMs: Date.now() - startedAt,
        metrics: { host: config.host, port: config.port, protocol: 'udp', response: true },
        errorMessage: null,
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.once('error', (err) => {
      finish({
        status: 'failed',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: truncateError(`${config.host}:${config.port} — ${err.message}`),
        screenshotPath: null,
        tracePath: null,
      });
    });
    socket.send(Buffer.alloc(0), config.port, config.host, (err) => {
      if (err) {
        finish({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          metrics: null,
          errorMessage: truncateError(`Failed to send UDP packet to ${config.host}:${config.port}: ${err.message}`),
          screenshotPath: null,
          tracePath: null,
        });
      }
    });
  });
}

export async function executePort(input: PortInput): Promise<ExecutionResult> {
  const { config, timeoutMs } = input;
  const startedAt = Date.now();
  try {
    if (config.protocol === 'udp') return await checkUdp(config, timeoutMs, startedAt);
    return config.tls ? await checkTls(config, timeoutMs, startedAt) : await checkTcp(config, timeoutMs, startedAt);
  } catch (err) {
    return {
      status: 'error',
      durationMs: Date.now() - startedAt,
      metrics: null,
      errorMessage: truncateError(err instanceof Error ? err.message : String(err)),
      screenshotPath: null,
      tracePath: null,
    };
  }
}
