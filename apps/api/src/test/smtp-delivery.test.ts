// SMTP delivery against a real SMTP server.
//
// Every other alerter test stops at an HTTP listener, so the email path — the
// one channel type that leaves HTTP entirely — was never executed end to end.
// smtp-server stands in for the relay: it speaks the actual protocol, so
// authentication, the envelope and the message body are all exercised rather
// than mocked.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { deliverToChannel, sampleAlertPayload } from '../services/alerter.js';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from './helpers.js';

interface Received {
  from: string;
  to: string[];
  body: string;
  auth: { user: string; pass: string } | null;
}

interface Relay {
  port: number;
  received: Received[];
  /** Reject AUTH, to exercise the failure path. */
  rejectAuth: boolean;
  /** Reject the message after AUTH succeeds. */
  rejectMessage: boolean;
  close: () => Promise<void>;
}

async function startRelay(): Promise<Relay> {
  const state = { received: [] as Received[], rejectAuth: false, rejectMessage: false };
  let lastAuth: { user: string; pass: string } | null = null;

  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authOptional: true,
    onAuth(auth, _session, callback) {
      if (state.rejectAuth) return callback(new Error('535 authentication failed'));
      lastAuth = { user: auth.username ?? '', pass: auth.password ?? '' };
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      let body = '';
      stream.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      stream.on('end', () => {
        if (state.rejectMessage) return callback(new Error('550 rejected'));
        state.received.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          body,
          auth: lastAuth,
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;

  return {
    port,
    get received() {
      return state.received;
    },
    set rejectAuth(v: boolean) {
      state.rejectAuth = v;
    },
    get rejectAuth() {
      return state.rejectAuth;
    },
    set rejectMessage(v: boolean) {
      state.rejectMessage = v;
    },
    get rejectMessage() {
      return state.rejectMessage;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let ctx: TestContext;
let relay: Relay;

beforeAll(async () => {
  ctx = await buildTestApp();
  relay = await startRelay();
});

afterAll(async () => {
  await relay.close();
  await closeTestApp(ctx);
});

beforeEach(async () => {
  await resetDb(ctx);
  relay.received.length = 0;
  relay.rejectAuth = false;
  relay.rejectMessage = false;
});

const PUBLIC_URL = 'http://localhost:8080';

function emailChannel(overrides: Record<string, unknown> = {}) {
  return {
    type: 'email' as const,
    config: {
      host: '127.0.0.1',
      port: relay.port,
      secure: false,
      from: 'vyzus@example.com',
      to: ['ops@example.com'],
      ...overrides,
    },
  };
}

describe('SMTP delivery', () => {
  it('delivers an alert to the relay', async () => {
    const outcome = await deliverToChannel(emailChannel(), null, sampleAlertPayload(PUBLIC_URL), PUBLIC_URL, {
      maxAttempts: 1,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    // SMTP reply codes are not surfaced uniformly by nodemailer, so this stays
    // null rather than inventing an HTTP-shaped number.
    expect(outcome.responseCode).toBeNull();

    expect(relay.received).toHaveLength(1);
    const mail = relay.received[0]!;
    expect(mail.from).toBe('vyzus@example.com');
    expect(mail.to).toEqual(['ops@example.com']);
  });

  it('sends to every recipient on the channel', async () => {
    await deliverToChannel(
      emailChannel({ to: ['ops@example.com', 'oncall@example.com', 'sre@example.com'] }),
      null,
      sampleAlertPayload(PUBLIC_URL),
      PUBLIC_URL,
      { maxAttempts: 1 },
    );

    expect(relay.received[0]!.to).toEqual(['ops@example.com', 'oncall@example.com', 'sre@example.com']);
  });

  it('renders a subject and both text and HTML bodies', async () => {
    await deliverToChannel(emailChannel(), null, sampleAlertPayload(PUBLIC_URL), PUBLIC_URL, { maxAttempts: 1 });

    const { body } = relay.received[0]!;
    expect(body).toMatch(/^Subject: .+$/m);
    // A multipart/alternative message is what makes the alert readable in a
    // client that refuses HTML and in one that prefers it.
    expect(body).toContain('multipart/alternative');
    expect(body).toContain('text/plain');
    expect(body).toContain('text/html');
  });

  it('authenticates when the channel carries credentials', async () => {
    await deliverToChannel(
      { ...emailChannel(), config: { ...emailChannel().config, username: 'vyzus' } },
      { password: 'smtp-p4ssword' },
      sampleAlertPayload(PUBLIC_URL),
      PUBLIC_URL,
      { maxAttempts: 1 },
    );

    // The password reaches the relay only by being decrypted from secrets_enc
    // and merged in at delivery — the same path a real send takes.
    expect(relay.received[0]!.auth).toEqual({ user: 'vyzus', pass: 'smtp-p4ssword' });
  });

  it('reports failure when the relay rejects the credentials', async () => {
    relay.rejectAuth = true;

    const outcome = await deliverToChannel(
      { ...emailChannel(), config: { ...emailChannel().config, username: 'vyzus' } },
      { password: 'wrong' },
      sampleAlertPayload(PUBLIC_URL),
      PUBLIC_URL,
      { maxAttempts: 1 },
    );

    expect(outcome.ok).toBe(false);
    expect(relay.received).toHaveLength(0);
  });

  it('retries a rejected message and reports the attempts', async () => {
    relay.rejectMessage = true;

    const outcome = await deliverToChannel(emailChannel(), null, sampleAlertPayload(PUBLIC_URL), PUBLIC_URL, {
      maxAttempts: 3,
      backoffBaseMs: 10,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
  });

  it('reports failure when nothing is listening', async () => {
    const outcome = await deliverToChannel(
      { ...emailChannel(), config: { ...emailChannel().config, port: 1 } },
      null,
      sampleAlertPayload(PUBLIC_URL),
      PUBLIC_URL,
      { maxAttempts: 1, timeoutMs: 2000 },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.responseCode).toBeNull();
  });
});
