// Config fields for the `ping` and `dns` uptime modes. Both answer "is the
// thing reachable", so they sit alongside http/port rather than being separate
// check types.
import type { DnsModeConfig, PingModeConfig } from '@vyzus/shared';
import { DNS_RECORD_TYPES } from '@vyzus/shared';
import { inputClass, labelClass } from './formFields';

export function PingConfigFields({
  config,
  onChange,
}: {
  config: PingModeConfig;
  onChange: (c: PingModeConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-zinc-400">
        ICMP echo — answers whether the host is reachable at all, which a port probe cannot: a machine with every port
        closed is still up.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <label htmlFor="ping-host" className={labelClass}>
            Host
          </label>
          <input
            id="ping-host"
            required
            value={config.host}
            onChange={(e) => onChange({ ...config, host: e.target.value })}
            className={inputClass}
            placeholder="example.com or 10.0.0.1"
          />
        </div>
        <div>
          <label htmlFor="ping-family" className={labelClass}>
            IP version
          </label>
          <select
            id="ping-family"
            value={config.family}
            onChange={(e) => onChange({ ...config, family: e.target.value as PingModeConfig['family'] })}
            className={inputClass}
          >
            <option value="auto">auto</option>
            <option value="4">IPv4</option>
            <option value="6">IPv6</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label htmlFor="ping-packets" className={labelClass}>
            Packets
          </label>
          <input
            id="ping-packets"
            type="number"
            min={1}
            max={10}
            value={config.packets}
            onChange={(e) => onChange({ ...config, packets: Number(e.target.value) || 1 })}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="ping-loss" className={labelClass}>
            Max loss %
          </label>
          <input
            id="ping-loss"
            type="number"
            min={0}
            max={99}
            placeholder="off"
            value={config.maxPacketLossPercent || ''}
            onChange={(e) => onChange({ ...config, maxPacketLossPercent: Number(e.target.value) || 0 })}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="ping-rtt" className={labelClass}>
            Max avg RTT (ms)
          </label>
          <input
            id="ping-rtt"
            type="number"
            min={0}
            max={60000}
            placeholder="off"
            value={config.maxRttMs || ''}
            onChange={(e) => onChange({ ...config, maxRttMs: Number(e.target.value) || 0 })}
            className={inputClass}
          />
        </div>
      </div>
      <p className="text-xs text-slate-400 dark:text-zinc-500">
        A host that answers nothing always fails. The loss and RTT limits are opt-in on top of that, for catching a link
        that is degraded rather than down.
      </p>
    </div>
  );
}

export function DnsConfigFields({
  config,
  onChange,
}: {
  config: DnsModeConfig;
  onChange: (c: DnsModeConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-zinc-400">
        Catches the failure where the service is fine but nobody can find it — an expired domain, a botched record
        change, a stale secondary.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <label htmlFor="dns-host" className={labelClass}>
            Name to resolve
          </label>
          <input
            id="dns-host"
            required
            value={config.host}
            onChange={(e) => onChange({ ...config, host: e.target.value })}
            className={inputClass}
            placeholder="example.com"
          />
        </div>
        <div>
          <label htmlFor="dns-type" className={labelClass}>
            Record
          </label>
          <select
            id="dns-type"
            value={config.recordType}
            onChange={(e) => onChange({ ...config, recordType: e.target.value as DnsModeConfig['recordType'] })}
            className={inputClass}
          >
            {DNS_RECORD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="dns-resolver" className={labelClass}>
          Resolver (optional)
        </label>
        <input
          id="dns-resolver"
          value={config.resolver ?? ''}
          onChange={(e) => onChange({ ...config, resolver: e.target.value || undefined })}
          className={inputClass}
          placeholder="1.1.1.1 — leave blank to use the system resolver"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
          Query a specific nameserver to catch a stale secondary or a propagation problem.
        </p>
      </div>
      <div>
        <label htmlFor="dns-expected" className={labelClass}>
          Expected values (optional)
        </label>
        <input
          id="dns-expected"
          value={config.expectedValues.join(', ')}
          onChange={(e) =>
            onChange({
              ...config,
              expectedValues: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
          className={inputClass}
          placeholder="93.184.216.34"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
          Comma-separated; each must appear somewhere in the answer. Leave blank to accept any successful resolution —
          asserting the value is opt-in because a correct answer changes more often than it stays put.
        </p>
      </div>
    </div>
  );
}
