// ICMP echo executor. Answers "is this host reachable at all", which a TCP port
// probe cannot: a host with every port closed is still up, and a router or an
// appliance may have no listening port worth probing.
//
// Shells out to iputils' `ping` rather than opening a socket in Node, because
// Node has no ICMP API and every npm alternative needs raw sockets (and so
// CAP_NET_RAW). The binary uses an unprivileged ICMP datagram socket, which
// Docker permits by default via net.ipv4.ping_group_range — so the worker keeps
// running as a plain non-root user.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PingModeConfig } from '@vyzus/shared';
import { truncateError, type ExecutionResult } from './types.js';

const run = promisify(execFile);

export interface PingInput {
  config: PingModeConfig;
  timeoutMs: number;
}

export interface PingSummary {
  transmitted: number;
  received: number;
  lossPercent: number;
  avgRttMs: number | null;
}

/**
 * Parse `ping -q` output. The quiet summary is far more stable across versions
 * and locales than the per-packet lines, which is why `-q` is used.
 *
 * Returns null when the summary is absent — treated as unreachable rather than
 * as a parse error, because that is what an unanswered ping looks like.
 */
export function parsePingSummary(output: string): PingSummary | null {
  const stats = /(\d+) packets transmitted,\s*(\d+)\s*(?:packets\s*)?received/.exec(output);
  if (!stats) return null;
  const transmitted = Number(stats[1]);
  const received = Number(stats[2]);
  const rtt = /(?:rtt|round-trip).*=\s*[\d.]+\/([\d.]+)\//.exec(output);
  return {
    transmitted,
    received,
    lossPercent: transmitted === 0 ? 100 : Math.round(((transmitted - received) / transmitted) * 100),
    avgRttMs: rtt ? Number(rtt[1]) : null,
  };
}

export async function executePing(input: PingInput): Promise<ExecutionResult> {
  const { config, timeoutMs } = input;
  const startedAt = Date.now();

  const args = ['-q', '-n', '-c', String(config.packets)];
  if (config.family === '4') args.push('-4');
  else if (config.family === '6') args.push('-6');
  // Per-packet deadline in seconds, and an overall deadline, so a black-holed
  // host cannot outlive the check's own timeout.
  const perPacketSeconds = Math.max(1, Math.floor(timeoutMs / 1000 / config.packets));
  args.push('-W', String(perPacketSeconds), '-w', String(Math.max(1, Math.floor(timeoutMs / 1000))));
  args.push(config.host);

  let output: string;
  try {
    const { stdout, stderr } = await run('ping', args, { timeout: timeoutMs + 2000, encoding: 'utf8' });
    output = stdout + stderr;
  } catch (err) {
    // ping exits non-zero when nothing came back, which is an answer, not an
    // error — the summary is still on stdout. Only a genuinely missing binary
    // or a resolution failure has nothing to parse.
    const e = err as { stdout?: string; stderr?: string; code?: string | number; message?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (e.code === 'ENOENT') {
      return {
        status: 'error',
        durationMs: Date.now() - startedAt,
        metrics: null,
        errorMessage: 'ping binary not available in the worker image',
        screenshotPath: null,
        tracePath: null,
      };
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary = parsePingSummary(output);
  if (!summary) {
    return {
      status: 'failed',
      durationMs,
      metrics: null,
      errorMessage: truncateError(`ping ${config.host} produced no result — ${output.trim() || 'no output'}`),
      screenshotPath: null,
      tracePath: null,
    };
  }

  const metrics: Record<string, unknown> = {
    host: config.host,
    transmitted: summary.transmitted,
    received: summary.received,
    packetLossPercent: summary.lossPercent,
    avgRttMs: summary.avgRttMs,
  };

  // Total loss is unreachable, whatever the loss threshold says.
  if (summary.received === 0) {
    return {
      status: 'failed',
      durationMs,
      metrics,
      errorMessage: `${config.host} did not answer any of ${summary.transmitted} ICMP echo(s)`,
      screenshotPath: null,
      tracePath: null,
    };
  }
  if (config.maxPacketLossPercent > 0 && summary.lossPercent > config.maxPacketLossPercent) {
    return {
      status: 'failed',
      durationMs,
      metrics,
      errorMessage: `${config.host} lost ${summary.lossPercent}% of ICMP echoes, over the ${config.maxPacketLossPercent}% limit`,
      screenshotPath: null,
      tracePath: null,
    };
  }
  if (config.maxRttMs > 0 && summary.avgRttMs !== null && summary.avgRttMs > config.maxRttMs) {
    return {
      status: 'failed',
      durationMs,
      metrics,
      errorMessage: `${config.host} averaged ${summary.avgRttMs} ms round-trip, over the ${config.maxRttMs} ms limit`,
      screenshotPath: null,
      tracePath: null,
    };
  }

  return { status: 'passed', durationMs, metrics, errorMessage: null, screenshotPath: null, tracePath: null };
}
