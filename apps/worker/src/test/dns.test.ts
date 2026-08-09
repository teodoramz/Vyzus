// DNS executor. Runs against a real resolver on localhost so the parsing and
// assertion logic is exercised end to end rather than mocked — node:dns is the
// thing under test as much as our code is.
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeDns } from '../executors/dns.js';

/**
 * Minimal DNS server answering A queries with a fixed address, so the test does
 * not depend on the internet or on whatever the host resolver happens to say.
 */
function startDnsServer(answer: string): Promise<{ port: number; close: () => Promise<void> }> {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve) => {
    socket.on('message', (msg, rinfo) => {
      // Echo the query back with one A answer appended. Header: copy the id,
      // set QR+RD+RA, one question, one answer.
      const qEnd = (() => {
        let i = 12;
        while (i < msg.length && msg[i] !== 0) i += msg[i]! + 1;
        return i + 5; // null label + qtype(2) + qclass(2)
      })();
      const header = Buffer.from(msg.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2); // QR, RD, RA, RCODE 0
      header.writeUInt16BE(1, 4); // QDCOUNT
      header.writeUInt16BE(1, 6); // ANCOUNT
      const question = msg.subarray(12, qEnd);
      const rdata = Buffer.from(answer.split('.').map(Number));
      const rr = Buffer.concat([
        Buffer.from([0xc0, 0x0c]), // pointer to the question name
        Buffer.from([0x00, 0x01, 0x00, 0x01]), // A, IN
        Buffer.from([0x00, 0x00, 0x00, 0x3c]), // TTL 60
        Buffer.from([0x00, 0x04]), // RDLENGTH
        rdata,
      ]);
      socket.send(Buffer.concat([header, question, rr]), rinfo.port, rinfo.address);
    });
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise((r) => socket.close(() => r())),
      });
    });
  });
}

let server: { port: number; close: () => Promise<void> };

beforeAll(async () => {
  server = await startDnsServer('93.184.216.34');
});
afterAll(async () => {
  await server.close();
});

const at = () => `127.0.0.1:${server.port}`;

describe('executeDns', () => {
  it('passes on a successful resolution and records what came back', async () => {
    const result = await executeDns({
      config: { mode: 'dns', host: 'example.com', recordType: 'A', resolver: at(), expectedValues: [] },
      timeoutMs: 5000,
    });
    expect(result.status).toBe('passed');
    const m = result.metrics as Record<string, unknown>;
    expect(m.records).toEqual(['93.184.216.34']);
    expect(m.recordCount).toBe(1);
  });

  it('passes when every expected value is present', async () => {
    const result = await executeDns({
      config: {
        mode: 'dns',
        host: 'example.com',
        recordType: 'A',
        resolver: at(),
        expectedValues: ['93.184.216.34'],
      },
      timeoutMs: 5000,
    });
    expect(result.status).toBe('passed');
  });

  // The case this mode exists for: the record changed under you.
  it('fails when an expected value is missing, and says what it got instead', async () => {
    const result = await executeDns({
      config: { mode: 'dns', host: 'example.com', recordType: 'A', resolver: at(), expectedValues: ['1.2.3.4'] },
      timeoutMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/missing "1\.2\.3\.4"/);
    expect(result.errorMessage).toMatch(/got 93\.184\.216\.34/);
  });

  it('fails rather than errors when the lookup itself fails', async () => {
    const result = await executeDns({
      // 203.0.113.0/24 is TEST-NET-3: guaranteed not to answer.
      config: { mode: 'dns', host: 'example.com', recordType: 'A', resolver: '203.0.113.1', expectedValues: [] },
      timeoutMs: 2000,
    });
    // NXDOMAIN/timeout is the answer, not an infrastructure fault of ours.
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/lookup for example\.com failed/);
  });

  it('errors on a resolver address that is not usable', async () => {
    const result = await executeDns({
      config: { mode: 'dns', host: 'example.com', recordType: 'A', resolver: 'not-an-ip', expectedValues: [] },
      timeoutMs: 2000,
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/Not a usable resolver address/);
  });
});
