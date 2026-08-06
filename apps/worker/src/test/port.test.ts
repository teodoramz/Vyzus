// Port executor: TCP connect/refuse/timeout, UDP response/silence/DNS-failure,
// TLS handshake + certificate trust.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executePort } from '../executors/port.js';

async function startTcpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startUdpServer(reply: boolean): Promise<{ port: number; close: () => Promise<void> }> {
  const socket = dgram.createSocket('udp4');
  if (reply) {
    socket.on('message', (_msg, rinfo) => socket.send(Buffer.from('pong'), rinfo.port, rinfo.address));
  }
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address() as AddressInfo;
  return { port, close: () => new Promise((resolve) => socket.close(() => resolve())) };
}

async function startTlsServer(cert: string, key: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = tls.createServer({ cert, key });
  server.on('secureConnection', (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('port executor', () => {
  describe('tcp', () => {
    it('passes when the port accepts a connection', async () => {
      const server = await startTcpServer();
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'tcp',
            family: 'auto',
            tls: false,
            allowInsecureCert: false,
          },
          timeoutMs: 5_000,
        });
        expect(result.status).toBe('passed');
        expect(result.metrics).toMatchObject({ host: '127.0.0.1', port: server.port, protocol: 'tcp' });
        expect(typeof (result.metrics as Record<string, unknown>).connectMs).toBe('number');
      } finally {
        await server.close();
      }
    });

    it('fails when the connection is actively refused', async () => {
      // A closed port on loopback refuses immediately (ECONNREFUSED) rather
      // than timing out — a reliable, deterministic "closed" signal.
      const server = await startTcpServer();
      const closedPort = server.port;
      await server.close();

      const result = await executePort({
        config: {
          mode: 'port',
          host: '127.0.0.1',
          port: closedPort,
          protocol: 'tcp',
          family: 'auto',
          tls: false,
          allowInsecureCert: false,
        },
        timeoutMs: 5_000,
      });
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain(String(closedPort));
    });

    it('times out against a non-routable address (RFC 5737 TEST-NET-1)', async () => {
      const result = await executePort({
        config: {
          mode: 'port',
          host: '192.0.2.1',
          port: 9,
          protocol: 'tcp',
          family: 'auto',
          tls: false,
          allowInsecureCert: false,
        },
        timeoutMs: 500,
      });
      expect(result.status).toBe('timeout');
      expect(result.errorMessage).toContain('timed out');
    }, 10_000);

    it('honors a forced IPv4 family against loopback', async () => {
      const server = await startTcpServer();
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'tcp',
            family: '4',
            tls: false,
            allowInsecureCert: false,
          },
          timeoutMs: 5_000,
        });
        expect(result.status).toBe('passed');
      } finally {
        await server.close();
      }
    });
  });

  describe('udp', () => {
    it('passes when a reply datagram arrives', async () => {
      const server = await startUdpServer(true);
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'udp',
            family: 'auto',
            tls: false,
            allowInsecureCert: false,
          },
          timeoutMs: 5_000,
        });
        expect(result.status).toBe('passed');
        expect(result.metrics).toMatchObject({ protocol: 'udp', response: true });
      } finally {
        await server.close();
      }
    });

    it('passes (with a note) when nothing replies and no error arrives — UDP is inconclusive by design', async () => {
      const server = await startUdpServer(false);
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'udp',
            family: 'auto',
            tls: false,
            allowInsecureCert: false,
          },
          timeoutMs: 400,
        });
        expect(result.status).toBe('passed');
        expect((result.metrics as Record<string, unknown>).note).toMatch(/inconclusive|reachable|no response/i);
      } finally {
        await server.close();
      }
    }, 10_000);

    it('fails when the host cannot be resolved', async () => {
      const result = await executePort({
        config: {
          mode: 'port',
          host: 'this-host-does-not-resolve.invalid',
          port: 53,
          protocol: 'udp',
          family: 'auto',
          tls: false,
          allowInsecureCert: false,
        },
        timeoutMs: 2_000,
      });
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('DNS');
    });
  });

  describe('tls', () => {
    let certDir: string;
    let cert: string;
    let key: string;

    beforeAll(async () => {
      certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vyzus-tls-'));
      const keyPath = path.join(certDir, 'key.pem');
      const certPath = path.join(certDir, 'cert.pem');
      // Self-signed, 1-day validity — plenty for a test run, and short
      // enough that a stale leftover on disk would never be mistaken for
      // something real.
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=vyzus-test-self-signed',
      ]);
      key = await fs.readFile(keyPath, 'utf8');
      cert = await fs.readFile(certPath, 'utf8');
    });

    afterAll(async () => {
      await fs.rm(certDir, { recursive: true, force: true });
    });

    it('fails a self-signed cert by default (allowInsecureCert: false)', async () => {
      const server = await startTlsServer(cert, key);
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'tcp',
            family: 'auto',
            tls: true,
            allowInsecureCert: false,
          },
          timeoutMs: 5_000,
        });
        expect(result.status).toBe('failed');
        expect(result.errorMessage).toMatch(/self.signed|certificate/i);
      } finally {
        await server.close();
      }
    });

    it('passes a self-signed cert when allowInsecureCert is true, and still reports cert details', async () => {
      const server = await startTlsServer(cert, key);
      try {
        const result = await executePort({
          config: {
            mode: 'port',
            host: '127.0.0.1',
            port: server.port,
            protocol: 'tcp',
            family: 'auto',
            tls: true,
            allowInsecureCert: true,
          },
          timeoutMs: 5_000,
        });
        expect(result.status).toBe('passed');
        const metrics = result.metrics as Record<string, unknown>;
        expect(metrics.authorized).toBe(false);
        expect(metrics.authorizationError).toBeTruthy();
        expect(metrics.certSubject).toBe('vyzus-test-self-signed');
        expect(typeof metrics.daysUntilExpiry).toBe('number');
      } finally {
        await server.close();
      }
    });

    it('fails when nothing is listening (TLS over a closed port)', async () => {
      const server = await startTcpServer();
      const closedPort = server.port;
      await server.close();

      const result = await executePort({
        config: {
          mode: 'port',
          host: '127.0.0.1',
          port: closedPort,
          protocol: 'tcp',
          family: 'auto',
          tls: true,
          allowInsecureCert: true,
        },
        timeoutMs: 5_000,
      });
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('handshake');
    });
  });
});
