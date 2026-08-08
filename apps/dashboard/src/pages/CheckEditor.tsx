// FR-2.4/FR-2.6/FR-4.5 check editor: form for uptime config (http or port
// mode) and journey specs (Monaco + dry-run). Handles both create
// (`/apps/:appId/checks/new`) and edit (`/checks/:checkId/edit`).
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CheckType,
  CreateCheckBody,
  DryRunBody,
  DryRunResult as DryRunResultType,
  HttpModeConfig,
  JourneyConfig,
  PortModeConfig,
  PushConfig,
  UptimeMode,
} from '@vyzus/shared';
import { DEFAULT_SCREENSHOT_REFRESH_MINUTES, DEFAULT_PUSH_GRACE_MINUTES } from '@vyzus/shared';
import { checksApi, appsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { HttpModeConfigFields } from '../components/HttpModeConfigFields';
import { PortConfigFields } from '../components/PortConfigFields';
import { JourneyConfigFields, DEFAULT_JOURNEY_SPEC } from '../components/JourneyConfigFields';
import { DryRunResult } from '../components/DryRunResult';
import { ConfirmButton } from '../components/ConfirmButton';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../components/formFields';

const TYPE_LABEL: Record<CheckType, string> = { uptime: 'Uptime', journey: 'Journey', push: 'Heartbeat (push)' };
const UPTIME_MODE_LABEL: Record<UptimeMode, string> = { http: 'HTTP(S) service', port: 'TCP/UDP port' };

function defaultHttpConfig(): HttpModeConfig {
  return {
    mode: 'http',
    expectedStatus: 200,
    screenshot: 'on_change',
    screenshotRefreshMinutes: DEFAULT_SCREENSHOT_REFRESH_MINUTES,
    maxDurationMs: 0,
    visualDiffPercent: 0,
    certExpiryWarningDays: 0,
  };
}
function defaultPortConfig(): PortModeConfig {
  return {
    mode: 'port',
    host: '',
    port: 443,
    protocol: 'tcp',
    family: 'auto',
    tls: true,
    allowInsecureCert: false,
    certExpiryWarningDays: 0,
  };
}
/** 32 bytes of CSPRNG output, hex — the only credential on the ping endpoint. */
function newPushToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function defaultPushConfig(): PushConfig {
  return { token: newPushToken(), graceMinutes: DEFAULT_PUSH_GRACE_MINUTES };
}
function defaultJourneyConfig(): JourneyConfig {
  return { specSource: DEFAULT_JOURNEY_SPEC };
}

export function CheckEditor(): JSX.Element {
  const params = useParams<{ appId?: string; checkId?: string }>();
  const isEdit = !!params.checkId;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const existing = useQuery({
    queryKey: ['checks', params.checkId],
    queryFn: () => checksApi.get(params.checkId!),
    enabled: isEdit,
  });

  const [appId, setAppId] = useState(params.appId ?? '');
  const [name, setName] = useState('');
  const [type, setType] = useState<CheckType>('uptime');
  const [uptimeMode, setUptimeMode] = useState<UptimeMode>('http');
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [failureThreshold, setFailureThreshold] = useState(2);
  const [enabled, setEnabled] = useState(true);
  const [httpConfig, setHttpConfig] = useState<HttpModeConfig>(defaultHttpConfig());
  const [portConfig, setPortConfig] = useState<PortModeConfig>(defaultPortConfig());
  const [journeyConfig, setJourneyConfig] = useState<JourneyConfig>(defaultJourneyConfig());
  const [pushConfig, setPushConfig] = useState<PushConfig>(defaultPushConfig());
  const [error, setError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResultType | null>(null);

  function goBack(): void {
    navigate(appId ? `/apps/${appId}` : '/');
  }

  // Esc closes the editor and returns to the app it belongs to — same
  // convention as every modal in the app (Modal.tsx), even though this is a
  // routed page rather than an overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') goBack();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goBack reads current appId via closure each keypress; re-binding per render is unnecessary
  }, [appId]);

  useEffect(() => {
    if (existing.data) {
      setAppId(existing.data.appId);
      setName(existing.data.name);
      setType(existing.data.type);
      setIntervalMinutes(existing.data.intervalMinutes);
      setTimeoutMs(existing.data.timeoutMs);
      setFailureThreshold(existing.data.failureThreshold);
      setEnabled(existing.data.enabled);
      if (existing.data.type === 'uptime') {
        const config = existing.data.config as HttpModeConfig | PortModeConfig;
        setUptimeMode(config.mode);
        if (config.mode === 'http') setHttpConfig(config);
        else setPortConfig(config);
      } else if (existing.data.type === 'push') {
        setPushConfig(existing.data.config as PushConfig);
      } else {
        setJourneyConfig(existing.data.config as JourneyConfig);
      }
    }
  }, [existing.data]);

  // New port-mode check: prefill the host from the app's own landing URL,
  // once — a ready-to-use starting point instead of a blank field. Only
  // fires while the host is still empty, so it never clobbers a user edit.
  const appForTemplate = useQuery({
    queryKey: ['app', appId, 'for-check-template'],
    queryFn: () => appsApi.get(appId),
    enabled: !isEdit && !!appId,
  });
  useEffect(() => {
    if (!appForTemplate.data || portConfig.host) return;
    try {
      setPortConfig((c) => (c.host ? c : { ...c, host: new URL(appForTemplate.data.landingUrl).hostname }));
    } catch {
      // landingUrl not parseable as a URL — leave host blank
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes portConfig.host: this seeds an empty field once, it must not re-fire as the user types
  }, [appForTemplate.data]);

  function buildBody(): CreateCheckBody {
    const base = { name, intervalMinutes, timeoutMs, failureThreshold, enabled };
    if (type === 'uptime') {
      return { ...base, type: 'uptime', config: uptimeMode === 'http' ? httpConfig : portConfig } as CreateCheckBody;
    }
    if (type === 'push') return { ...base, type: 'push', config: pushConfig } as CreateCheckBody;
    return { ...base, type: 'journey', config: journeyConfig } as CreateCheckBody;
  }

  // Dry run targets a specific app (for its landing URL / credentials) and
  // doesn't take name/interval/failureThreshold — see dryRunBodySchema.
  function buildDryRunBody(): DryRunBody {
    if (type === 'uptime') {
      return {
        appId,
        timeoutMs,
        type: 'uptime',
        config: uptimeMode === 'http' ? httpConfig : portConfig,
      } as DryRunBody;
    }
    return { appId, timeoutMs, type: 'journey', config: journeyConfig } as DryRunBody;
  }

  const dryRun = useMutation({
    mutationFn: () => checksApi.dryRun(buildDryRunBody()),
    onSuccess: (result) => {
      setDryRunResult(result);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? `Dry run failed: ${err.message}` : 'Dry run failed'),
  });

  const save = useMutation({
    mutationFn: () => (isEdit ? checksApi.update(params.checkId!, buildBody()) : checksApi.create(appId, buildBody())),
    onSuccess: (check) => {
      void qc.invalidateQueries({ queryKey: ['checks'] });
      void qc.invalidateQueries({ queryKey: ['app', check.appId] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
      navigate(`/apps/${check.appId}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save check'),
  });

  const remove = useMutation({
    mutationFn: () => checksApi.remove(params.checkId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['apps'] });
      navigate(existing.data ? `/apps/${existing.data.appId}` : '/');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to delete check'),
  });

  if (isEdit && existing.isLoading) return <p className="text-slate-400 dark:text-zinc-500">Loading check…</p>;
  if (isEdit && existing.isError) return <p className="text-red-600 dark:text-rose-500">Failed to load check.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{isEdit ? `Edit check — ${existing.data?.name ?? ''}` : 'New check'}</h1>
        <button
          type="button"
          onClick={goBack}
          aria-label="Close"
          title="Close (Esc)"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-gray-100 dark:text-zinc-500 dark:hover:bg-white/10"
        >
          ✕
        </button>
      </div>

      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
        <div>
          <label htmlFor="check-name" className={labelClass}>
            Name
          </label>
          <input
            id="check-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <span className={labelClass}>Type</span>
          <div className="flex gap-4">
            {(['uptime', 'journey'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} disabled={isEdit} />
                {TYPE_LABEL[t]}
              </label>
            ))}
          </div>
          {isEdit && (
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">Type can't be changed after creation.</p>
          )}
        </div>

        {type === 'uptime' && (
          <div>
            <span className={labelClass}>Uptime checks — what is it probing?</span>
            <div className="flex gap-4">
              {(['http', 'port'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="uptimeMode"
                    checked={uptimeMode === m}
                    onChange={() => setUptimeMode(m)}
                    disabled={isEdit}
                  />
                  {UPTIME_MODE_LABEL[m]}
                </label>
              ))}
            </div>
            {isEdit && (
              <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">Mode can't be changed after creation.</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="interval" className={labelClass}>
              Interval (min)
            </label>
            <input
              id="interval"
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="timeout" className={labelClass}>
              Timeout (ms)
            </label>
            <input
              id="timeout"
              type="number"
              min={1000}
              max={300_000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="threshold" className={labelClass}>
              Failure threshold
            </label>
            <input
              id="threshold"
              type="number"
              min={1}
              max={20}
              value={failureThreshold}
              onChange={(e) => setFailureThreshold(Number(e.target.value))}
              className={inputClass}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <hr className="border-gray-200 dark:border-white/10" />

        {type === 'uptime' && uptimeMode === 'http' && (
          <HttpModeConfigFields config={httpConfig} onChange={setHttpConfig} />
        )}
        {type === 'uptime' && uptimeMode === 'port' && (
          <PortConfigFields config={portConfig} onChange={setPortConfig} />
        )}
        {type === 'push' && (
          <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-white/10">
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Vyzus does not reach out for this check — the job reports in. Have it request the URL below on success.
              The check fails when nothing arrives within its interval plus the grace allowance, which is how a cron job
              that silently stopped becomes visible.
            </p>
            <div>
              <label htmlFor="push-url" className={labelClass}>
                Ping URL
              </label>
              <input
                id="push-url"
                readOnly
                value={`${window.location.origin}/api/v1/push/${pushConfig.token}`}
                onFocus={(e) => e.currentTarget.select()}
                className={`${inputClass} font-mono text-xs`}
              />
              <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
                The token is the only credential — treat it as a secret. Regenerate it to revoke.
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label htmlFor="push-grace" className={labelClass}>
                  Grace (minutes)
                </label>
                <input
                  id="push-grace"
                  type="number"
                  min={0}
                  max={1440}
                  value={pushConfig.graceMinutes}
                  onChange={(e) => setPushConfig({ ...pushConfig, graceMinutes: Number(e.target.value) || 0 })}
                  className={`${inputClass} max-w-28`}
                />
              </div>
              <button
                type="button"
                onClick={() => setPushConfig({ ...pushConfig, token: newPushToken() })}
                className={secondaryButtonClass}
              >
                Regenerate token
              </button>
            </div>
            <p className="text-xs text-slate-400 dark:text-zinc-500">
              A job on a {intervalMinutes}-minute schedule will not land exactly on the mark, so it is allowed{' '}
              {intervalMinutes + pushConfig.graceMinutes} minutes total before a missing ping counts as a failure.
            </p>
          </div>
        )}

        {type === 'journey' && <JourneyConfigFields config={journeyConfig} onChange={setJourneyConfig} />}
      </div>

      {error && (
        <p className="rounded bg-red-600/10 dark:bg-rose-500/10 px-3 py-2 text-sm text-red-600 dark:text-rose-500">
          {error}
        </p>
      )}

      {dryRunResult && <DryRunResult result={dryRunResult} />}

      <div className="flex items-center justify-between">
        <div>
          {isEdit && (
            <ConfirmButton
              label="Delete check"
              confirmLabel={`Delete check "${name}"?`}
              pendingLabel="Deleting…"
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={goBack} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void dryRun.mutate()}
            disabled={dryRun.isPending || !appId}
            className={secondaryButtonClass}
          >
            {dryRun.isPending ? 'Running…' : 'Dry run'}
          </button>
          <button
            type="button"
            onClick={() => void save.mutate()}
            disabled={save.isPending || !name || (!isEdit && !appId)}
            className={primaryButtonClass}
          >
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create check'}
          </button>
        </div>
      </div>
    </div>
  );
}
