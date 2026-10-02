// Custom webhook bodies.
//
// The built-in channel types cover the services whose formats are known. A
// `webhook` channel can instead carry a template: the exact JSON to POST, with
// `{{placeholders}}` filled from the alert. That is what lets one instance
// drive a service nobody here has heard of.
//
// Substitution is textual and placeholders carry no logic — no conditionals,
// no loops, no expressions. A template is data an operator typed, and the only
// thing it should be able to do is produce a document.
import { isMonitoringAlert, type AlertWebhookPayload } from './alerts.js';

/** `{{ name }}` — spaces around the name are tolerated. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function downtime(seconds: number | null): string {
  if (seconds === null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Everything a template may refer to, flattened and already stringified.
 *
 * A monitoring alert has no application, check or run — nothing ran, that is
 * the alert. Those names resolve to empty rather than being absent, so one
 * template can serve both kinds without the author having to branch.
 */
export function alertTemplateVariables(p: AlertWebhookPayload, publicUrl: string): Record<string, string> {
  const base: Record<string, string> = {
    event: p.event,
    timestamp: p.timestamp,
    dashboardUrl: publicUrl,
  };

  if (isMonitoringAlert(p)) {
    const stalled = p.event === 'monitoring.stalled';
    return {
      ...base,
      status: stalled ? 'STALLED' : 'RESUMED',
      title: stalled ? 'MONITORING STALLED — no checks are running' : 'MONITORING RESUMED',
      summary: stalled
        ? `No check has completed in ${downtime(p.monitoring.silentForSeconds)}. Vyzus itself may be down.`
        : 'Checks are completing again.',
      'monitoring.lastRunAt': p.monitoring.lastRunAt ?? 'never',
      'monitoring.silentForSeconds': String(p.monitoring.silentForSeconds),
      'monitoring.thresholdMinutes': String(p.monitoring.thresholdMinutes),
      'application.id': '',
      'application.name': '',
      'application.landingUrl': '',
      'application.url': '',
      'check.id': '',
      'check.name': '',
      'check.type': '',
      'incident.id': '',
      'incident.openedAt': '',
      'incident.resolvedAt': '',
      'incident.downtime': '',
      'run.id': '',
      'run.status': '',
      'run.errorMessage': '',
      'run.screenshotUrl': '',
      'run.url': '',
    };
  }

  const down = p.event === 'check.down';
  return {
    ...base,
    status: down ? 'DOWN' : 'RECOVERED',
    title: `${down ? 'DOWN' : 'RECOVERED'}: ${p.application.name} — ${p.check.name}`,
    summary: down
      ? (p.run.errorMessage ?? 'The check failed.')
      : `Recovered after ${downtime(p.incident.downtimeSeconds)}.`,
    'application.id': p.application.id,
    'application.name': p.application.name,
    'application.landingUrl': p.application.landingUrl,
    'application.url': `${publicUrl}/apps/${p.application.id}`,
    'check.id': p.check.id,
    'check.name': p.check.name,
    'check.type': p.check.type,
    'incident.id': p.incident.id,
    'incident.openedAt': p.incident.openedAt,
    'incident.resolvedAt': p.incident.resolvedAt ?? '',
    'incident.downtime': downtime(p.incident.downtimeSeconds),
    'run.id': p.run.id,
    'run.status': p.run.status,
    'run.errorMessage': p.run.errorMessage ?? '',
    'run.screenshotUrl': p.run.screenshotUrl ?? '',
    'run.url': `${publicUrl}/runs/${p.run.id}`,
    'monitoring.lastRunAt': '',
    'monitoring.silentForSeconds': '',
    'monitoring.thresholdMinutes': '',
  };
}

/** The names a template may use, for the editor to list. */
export const ALERT_TEMPLATE_VARIABLES = [
  'status',
  'title',
  'summary',
  'event',
  'timestamp',
  'dashboardUrl',
  'application.name',
  'application.url',
  'application.landingUrl',
  'check.name',
  'check.type',
  'run.status',
  'run.errorMessage',
  'run.screenshotUrl',
  'run.url',
  'incident.downtime',
  'incident.openedAt',
] as const;

/**
 * Fill a template.
 *
 * Values are escaped as JSON string contents, so a placeholder belongs inside
 * quotes — `"text": "{{summary}}"`. An error message full of quotes and
 * newlines then cannot break out of its string and corrupt the document, which
 * is exactly the input most likely to try.
 *
 * An unknown name renders empty rather than raising: an alert that reaches a
 * typo at 3am should still be delivered, just with a gap in it.
 */
export function renderAlertTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    // Own properties only: a plain object inherits `constructor`, `toString`
    // and friends, so a bare `variables[name]` would resolve `{{constructor}}`
    // to a function and stringify it to nothing useful.
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return JSON.stringify(value ?? '').slice(1, -1);
  });
}

/**
 * Whether a template produces valid JSON once filled.
 *
 * Checked when the channel is saved rather than when an alert fires, so a
 * broken template is a form error in front of the person who wrote it instead
 * of a delivery failure nobody is watching.
 */
export function validateAlertTemplate(template: string): { ok: true } | { ok: false; error: string } {
  const probe: Record<string, string> = {};
  for (const name of ALERT_TEMPLATE_VARIABLES) probe[name] = 'sample';

  const rendered = renderAlertTemplate(template, probe);
  try {
    const parsed: unknown = JSON.parse(rendered);
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, error: 'Template must produce a JSON object or array' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Template is not valid JSON' };
  }
}

/** Starter templates for services whose format is known. */
export const ALERT_TEMPLATE_PRESETS: { id: string; label: string; hint: string; template: string }[] = [
  {
    id: 'mattermost-text',
    label: 'Mattermost — plain text',
    hint: 'The simplest incoming-webhook body Mattermost accepts.',
    template: '{\n  "text": "**{{title}}**\\n{{summary}}\\n[Open in Vyzus]({{application.url}})"\n}',
  },
  {
    id: 'slack-text',
    label: 'Slack — plain text',
    hint: 'Also accepted by anything Slack-compatible.',
    template: '{\n  "text": "{{title}}\\n{{summary}}\\n{{application.url}}"\n}',
  },
  {
    id: 'teams-card',
    label: 'Microsoft Teams — message card',
    hint: 'The legacy connector card format Teams still accepts.',
    template: [
      '{',
      '  "@type": "MessageCard",',
      '  "@context": "https://schema.org/extensions",',
      '  "summary": "{{title}}",',
      '  "title": "{{title}}",',
      '  "text": "{{summary}}",',
      '  "potentialAction": [',
      '    {',
      '      "@type": "OpenUri",',
      '      "name": "Open in Vyzus",',
      '      "targets": [{ "os": "default", "uri": "{{application.url}}" }]',
      '    }',
      '  ]',
      '}',
    ].join('\n'),
  },
  {
    id: 'minimal',
    label: 'Minimal JSON',
    hint: 'A starting point for a service of your own.',
    template: '{\n  "status": "{{status}}",\n  "application": "{{application.name}}",\n  "detail": "{{summary}}"\n}',
  },
];
