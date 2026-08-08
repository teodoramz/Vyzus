// Email alert rendering. Pure — no SMTP, no database — so it is the part of the
// email channel that can be verified in full without infrastructure.
//
// The case most likely to be missed: the alerter delivers BOTH payload variants
// to every matching channel, so a renderer that only understands check alerts
// throws on the platform alert telling you the monitoring itself stopped. That
// is asserted here rather than left as a comment.
import { describe, expect, it } from 'vitest';
import type { AlertWebhookPayload } from '@vyzus/shared';
import { renderEmailBody, sampleAlertPayload } from '../services/alerter.js';

const PUBLIC_URL = 'https://vyzus.example.com';

const downPayload: AlertWebhookPayload = {
  event: 'check.down',
  application: { id: '00000000-0000-4000-8000-000000000001', name: 'Shop', landingUrl: 'https://shop.example.com' },
  check: { id: '00000000-0000-4000-8000-000000000002', name: 'Landing uptime', type: 'uptime' },
  incident: {
    id: '00000000-0000-4000-8000-000000000003',
    openedAt: '2026-08-08T10:00:00.000Z',
    resolvedAt: null,
    downtimeSeconds: null,
  },
  run: {
    id: '00000000-0000-4000-8000-000000000004',
    status: 'failed',
    errorMessage: 'Expected HTTP 200, got 503',
    screenshotUrl: `${PUBLIC_URL}/api/v1/runs/00000000-0000-4000-8000-000000000004/artifacts/screenshot`,
  },
  timestamp: '2026-08-08T10:00:01.000Z',
};

const recoveredPayload: AlertWebhookPayload = {
  ...downPayload,
  event: 'check.recovered',
  incident: { ...downPayload.incident, resolvedAt: '2026-08-08T10:30:00.000Z', downtimeSeconds: 1800 },
  run: { ...downPayload.run, status: 'passed', errorMessage: null, screenshotUrl: null },
};

const stalledPayload: AlertWebhookPayload = {
  event: 'monitoring.stalled',
  monitoring: { lastRunAt: '2026-08-08T09:00:00.000Z', silentForSeconds: 3600, thresholdMinutes: 15 },
  timestamp: '2026-08-08T10:00:00.000Z',
};

describe('renderEmailBody', () => {
  it('renders a down alert with the error and both links', () => {
    const { subject, text, html } = renderEmailBody(downPayload, PUBLIC_URL);
    expect(subject).toBe('[Vyzus] DOWN: Shop — Landing uptime');
    expect(text).toContain('Expected HTTP 200, got 503');
    expect(text).toContain(`${PUBLIC_URL}/apps/${downPayload.application.id}`);
    expect(text).toContain(`${PUBLIC_URL}/runs/${downPayload.run.id}`);
    expect(html).toContain('Landing uptime');
    // The screenshot is the evidence; an alert without it wastes the capture.
    expect(text).toContain('artifacts/screenshot');
    expect(html).toContain('<img');
  });

  it('renders a recovery with downtime instead of an error', () => {
    const { subject, text, html } = renderEmailBody(recoveredPayload, PUBLIC_URL);
    expect(subject).toBe('[Vyzus] Recovered: Shop — Landing uptime');
    expect(text).toContain('Downtime: 30m 0s');
    expect(text).not.toContain('Expected HTTP 200');
    // No screenshot on this run, so no broken <img>.
    expect(html).not.toContain('<img');
  });

  // Would throw before the isMonitoringAlert() branch existed.
  it('renders a platform stall alert, which carries no application or run', () => {
    const { subject, text, html } = renderEmailBody(stalledPayload, PUBLIC_URL);
    expect(subject).toMatch(/MONITORING STALLED/);
    expect(text).toContain('1h 0m');
    expect(text).toContain('threshold 15m');
    expect(text).toContain(PUBLIC_URL);
    expect(html).toContain('Monitoring stalled');
  });

  it('renders the resumed counterpart', () => {
    const { subject, text } = renderEmailBody({ ...stalledPayload, event: 'monitoring.resumed' }, PUBLIC_URL);
    expect(subject).toBe('[Vyzus] Monitoring resumed');
    expect(text).toContain('completing again');
  });

  // The application name is operator-supplied and lands inside HTML.
  it('escapes HTML in operator-supplied text', () => {
    const { html } = renderEmailBody(
      {
        ...downPayload,
        application: { ...downPayload.application, name: '<script>alert(1)</script>' },
      },
      PUBLIC_URL,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the sample payload used by the channel test button', () => {
    const { subject, text } = renderEmailBody(sampleAlertPayload(PUBLIC_URL), PUBLIC_URL);
    expect(subject).toContain('Vyzus');
    expect(text.length).toBeGreaterThan(0);
  });
});
