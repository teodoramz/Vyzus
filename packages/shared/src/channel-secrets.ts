// Splitting channel credentials out of the stored config.
//
// `alert_channels.config` is plain jsonb: it is queried, returned to the
// dashboard and included in any database dump. Credentials do not belong there,
// so they are separated here and stored encrypted alongside — the same
// treatment `applications.auth_config_enc` already gives target credentials.
//
// Pure, so the split and merge are symmetrical and testable without a key.
import type { ChannelConfig } from './schemas/channels.js';

/** The credential fields, extracted from a config. */
export interface ChannelSecrets {
  /** Webhook HMAC signing secret. */
  secret?: string;
  /** SMTP password. */
  password?: string;
}

/**
 * Separate a config into the part safe to store in plain jsonb and the part
 * that must be encrypted.
 */
export function splitChannelSecrets(config: ChannelConfig): { config: ChannelConfig; secrets: ChannelSecrets | null } {
  const rest = { ...config } as ChannelConfig & { secret?: string; password?: string };
  const secrets: ChannelSecrets = {};

  if (typeof rest.secret === 'string') {
    secrets.secret = rest.secret;
    delete rest.secret;
  }
  if (typeof rest.password === 'string') {
    secrets.password = rest.password;
    delete rest.password;
  }

  return { config: rest as ChannelConfig, secrets: Object.keys(secrets).length > 0 ? secrets : null };
}

/** Reassemble the full config for delivery. */
export function mergeChannelSecrets(config: ChannelConfig, secrets: ChannelSecrets | null): ChannelConfig {
  if (!secrets) return config;
  return { ...config, ...secrets } as ChannelConfig;
}
