import type { PortModeConfig } from '@vyzus/shared';
import { inputClass, labelClass } from './formFields';

// Common services for the quick-pick — sets port/protocol/tls in one click;
// host is left alone since it's app-specific (already prefilled from the
// app's landing URL by CheckEditor).
const COMMON_SERVICES: { label: string; port: number; protocol: 'tcp' | 'udp'; tls: boolean }[] = [
  { label: 'HTTP (80)', port: 80, protocol: 'tcp', tls: false },
  { label: 'HTTPS (443)', port: 443, protocol: 'tcp', tls: true },
  { label: 'SSH (22)', port: 22, protocol: 'tcp', tls: false },
  { label: 'FTP (21)', port: 21, protocol: 'tcp', tls: false },
  { label: 'FTPS (990)', port: 990, protocol: 'tcp', tls: true },
  { label: 'SMTP (25)', port: 25, protocol: 'tcp', tls: false },
  { label: 'SMTP Submission (587)', port: 587, protocol: 'tcp', tls: false },
  { label: 'SMTPS (465)', port: 465, protocol: 'tcp', tls: true },
  { label: 'POP3 (110)', port: 110, protocol: 'tcp', tls: false },
  { label: 'POP3S (995)', port: 995, protocol: 'tcp', tls: true },
  { label: 'IMAP (143)', port: 143, protocol: 'tcp', tls: false },
  { label: 'IMAPS (993)', port: 993, protocol: 'tcp', tls: true },
  { label: 'DNS (53, UDP)', port: 53, protocol: 'udp', tls: false },
  { label: 'MySQL / MariaDB (3306)', port: 3306, protocol: 'tcp', tls: false },
  { label: 'PostgreSQL (5432)', port: 5432, protocol: 'tcp', tls: false },
  { label: 'Redis (6379)', port: 6379, protocol: 'tcp', tls: false },
  { label: 'MongoDB (27017)', port: 27017, protocol: 'tcp', tls: false },
  { label: 'RDP (3389)', port: 3389, protocol: 'tcp', tls: false },
  { label: 'LDAP (389)', port: 389, protocol: 'tcp', tls: false },
  { label: 'LDAPS (636)', port: 636, protocol: 'tcp', tls: true },
];

export function PortConfigFields({
  config,
  onChange,
}: {
  config: PortModeConfig;
  onChange: (config: PortModeConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="port-host" className={labelClass}>
          Host
        </label>
        <input
          id="port-host"
          value={config.host}
          onChange={(e) => onChange({ ...config, host: e.target.value })}
          className={inputClass}
          placeholder="example.com, 192.0.2.1, or 2001:db8::1"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
          Domain name or IP literal — no scheme, no path.
        </p>
      </div>

      <div>
        <label htmlFor="port-preset" className={labelClass}>
          Common service (optional)
        </label>
        <select
          id="port-preset"
          value=""
          onChange={(e) => {
            const preset = COMMON_SERVICES.find((s) => s.label === e.target.value);
            if (preset) onChange({ ...config, port: preset.port, protocol: preset.protocol, tls: preset.tls });
          }}
          className={inputClass}
        >
          <option value="">Choose to fill in port / protocol / TLS…</option>
          {COMMON_SERVICES.map((s) => (
            <option key={s.label} value={s.label}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="port-number" className={labelClass}>
            Port
          </label>
          <input
            id="port-number"
            type="number"
            min={1}
            max={65535}
            value={config.port}
            onChange={(e) => onChange({ ...config, port: Number(e.target.value) })}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="port-protocol" className={labelClass}>
            Protocol
          </label>
          <select
            id="port-protocol"
            value={config.protocol}
            onChange={(e) => {
              const protocol = e.target.value as PortModeConfig['protocol'];
              onChange({ ...config, protocol, tls: protocol === 'udp' ? false : config.tls });
            }}
            className={inputClass}
          >
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="port-family" className={labelClass}>
          IP version
        </label>
        <select
          id="port-family"
          value={config.family}
          onChange={(e) => onChange({ ...config, family: e.target.value as PortModeConfig['family'] })}
          className={inputClass}
        >
          <option value="auto">Auto (system default)</option>
          <option value="4">Force IPv4</option>
          <option value="6">Force IPv6</option>
        </select>
      </div>

      {config.protocol === 'udp' && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          UDP has no connection handshake, so "up" here means no ICMP port-unreachable error came back within the
          timeout — not proof a service actually answered. Prefer TCP when the target supports it.
        </p>
      )}

      {config.protocol === 'tcp' && (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-white/10">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.tls}
              onChange={(e) => onChange({ ...config, tls: e.target.checked })}
            />
            TLS (check the certificate, not just the connection)
          </label>

          {config.tls && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.allowInsecureCert}
                  onChange={(e) => onChange({ ...config, allowInsecureCert: e.target.checked })}
                />
                Allow an insecure certificate (self-signed, untrusted CA, expired)
              </label>
              <p className="text-xs text-slate-400 dark:text-zinc-500">
                {config.allowInsecureCert
                  ? "The handshake completing is all that's checked — cert details (issuer, expiry, trust) are still recorded on every run, just not enforced. For a deliberately self-signed internal service."
                  : 'An invalid certificate — expired, self-signed, untrusted CA, or hostname mismatch — fails the check exactly like a closed port.'}
              </p>

              <label className="block space-y-1 text-sm">
                <span className="font-medium">Warn before expiry (days)</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={config.certExpiryWarningDays}
                  onChange={(e) => onChange({ ...config, certExpiryWarningDays: Number(e.target.value) || 0 })}
                  className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:focus:border-cyan-400"
                />
              </label>
              <p className="text-xs text-slate-400 dark:text-zinc-500">
                {config.certExpiryWarningDays > 0
                  ? `The check fails once the certificate has ${config.certExpiryWarningDays} day(s) or less remaining, so the renewal has a window to happen in.`
                  : 'Off — the certificate only fails the check once it has already expired, which is usually too late to act on.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
