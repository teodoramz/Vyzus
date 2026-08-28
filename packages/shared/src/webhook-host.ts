// Which hosts an alert webhook may point at.
//
// POST /channels/:id/test reports whether a caller-supplied URL answered and
// with what status, so any account holder can use it as a probe. Blocked:
// loopback and link-local (169.254.169.254 serves cloud credentials) — never
// real notification targets. Private ranges stay allowed: notifying a
// self-hosted service on the LAN is the normal deployment.

/**
 * The four octets of an IPv4 address, or null when the host is not one.
 * Unwraps IPv4-mapped IPv6: WHATWG URL normalises `::ffff:127.0.0.1` to
 * `::ffff:7f00:1`, so matching the dotted quad alone would miss it.
 */
function toIpv4Octets(host: string): [number, number, number, number] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) {
    const parts = dotted.slice(1).map(Number) as [number, number, number, number];
    return parts.every((n) => n <= 255) ? parts : null;
  }

  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mappedDotted) return toIpv4Octets(mappedDotted[1]!);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  }

  return null;
}

/** Hosts that are never a legitimate webhook target. */
export function isBlockedWebhookHost(hostname: string): boolean {
  // Strip the brackets URL puts around IPv6 literals, and the trailing dot of a
  // fully qualified name — `localhost.` resolves identically and WHATWG keeps
  // it on a name (it strips it after an IPv4 literal).
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const v4 = toIpv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true; // 127.0.0.0/8 — loopback
    if (a === 0) return true; // 0.0.0.0/8 — "this host"
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    return false;
  }

  if (host === '::1' || host === '::') return true;
  // fe80::/10 — IPv6 link-local.
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

/** Shared so every caller rejects with the same wording. */
export const BLOCKED_WEBHOOK_HOST_MESSAGE =
  'Webhook URL may not point at loopback or link-local addresses. Use an address reachable from the Vyzus container.';

/** True when the URL is well-formed and its host is allowed. */
export function isAllowedWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // malformed: the URL validator reports that, not this
  }
  return !isBlockedWebhookHost(parsed.hostname);
}
