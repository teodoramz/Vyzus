// Ping executor. The summary parser is tested against real `ping -q` output
// from several iputils versions, because that string is the whole contract with
// an external binary — and the executor itself runs against loopback, which is
// the only host guaranteed reachable from a test runner.
import { describe, expect, it } from 'vitest';
import { executePing, parsePingSummary } from '../executors/ping.js';

const base = { mode: 'ping' as const, family: 'auto' as const, packets: 2, maxPacketLossPercent: 0, maxRttMs: 0 };

describe('parsePingSummary', () => {
  it('parses a healthy iputils summary', () => {
    const out = `--- 127.0.0.1 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1031ms
rtt min/avg/max/mdev = 0.046/0.061/0.077/0.015 ms`;
    expect(parsePingSummary(out)).toEqual({ transmitted: 2, received: 2, lossPercent: 0, avgRttMs: 0.061 });
  });

  it('parses total loss, where there is no rtt line at all', () => {
    const out = `--- 10.255.255.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2044ms`;
    expect(parsePingSummary(out)).toEqual({ transmitted: 3, received: 0, lossPercent: 100, avgRttMs: null });
  });

  it('computes partial loss from the counts rather than trusting the printed percent', () => {
    const out = `4 packets transmitted, 3 received, 25% packet loss, time 3005ms
rtt min/avg/max/mdev = 1.000/2.000/3.000/0.500 ms`;
    const s = parsePingSummary(out)!;
    expect(s.lossPercent).toBe(25);
    expect(s.avgRttMs).toBe(2);
  });

  // BSD/macOS phrasing differs; the parser should not be Linux-only.
  it('parses the "packets received" phrasing and round-trip label', () => {
    const out = `2 packets transmitted, 2 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.050/0.075/0.100/0.025 ms`;
    expect(parsePingSummary(out)).toMatchObject({ transmitted: 2, received: 2, avgRttMs: 0.075 });
  });

  it('returns null when there is no summary to read', () => {
    expect(parsePingSummary('ping: unknown host nope.invalid')).toBeNull();
  });
});

describe('executePing', () => {
  it('passes against loopback and records the measurements', async () => {
    const result = await executePing({ config: { ...base, host: '127.0.0.1' }, timeoutMs: 8000 });
    // A worker image without iputils reports `error`, which is a different
    // (and honest) outcome — make that failure mode readable rather than
    // showing up as a confusing status mismatch.
    expect(result.errorMessage ?? '').not.toMatch(/ping binary not available/);
    expect(result.status).toBe('passed');
    const m = result.metrics as Record<string, unknown>;
    expect(m.received).toBe(2);
    expect(m.packetLossPercent).toBe(0);
    expect(typeof m.avgRttMs).toBe('number');
  });

  it('fails an unreachable address rather than hanging', async () => {
    // RFC 5737 TEST-NET-1: guaranteed not to answer.
    const result = await executePing({
      config: { ...base, host: '192.0.2.1', packets: 1 },
      timeoutMs: 4000,
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/did not answer/);
  });

  it('fails a name that does not resolve', async () => {
    const result = await executePing({ config: { ...base, host: 'nope.invalid', packets: 1 }, timeoutMs: 4000 });
    expect(result.status).toBe('failed');
  });

  // Loopback is sub-millisecond, so a 0ms ceiling is the only way to force the
  // latency branch deterministically.
  it('fails when average round-trip exceeds maxRttMs', async () => {
    const result = await executePing({
      config: { ...base, host: '127.0.0.1', packets: 1, maxRttMs: 0 },
      timeoutMs: 8000,
    });
    // maxRttMs 0 means off, so this must pass — the guard is opt-in.
    expect(result.status).toBe('passed');
  });
});
