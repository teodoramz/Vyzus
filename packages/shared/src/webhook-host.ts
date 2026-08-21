// Which hosts an alert webhook may point at.
//
// Any account holder can create a channel and fire it with POST
// /channels/:id/test, which reports back whether the request connected and with
// what status. That makes the endpoint a probe, so the destination is worth a
// look before it is stored.
//
// The line is drawn at addresses that are never a real notification target and
// are valuable to reach: the API's own loopback interface (services that bind
// to 127.0.0.1 do so precisely because they expect no outside callers) and
// link-local, which is where cloud instances serve credentials at
// 169.254.169.254.
//
// Private ranges are deliberately allowed. A self-hosted Vyzus notifying a
// self-hosted Mattermost at 10.0.0.5 is the normal case for this product, and
// blocking it would break more than it protects. See the tracking issue for
// what that leaves open.

/**
 * The four octets of an IPv4 address, or null when the host is not one.
 *
 * Also unwraps IPv4-mapped IPv6, which is loopback wearing a different hat.
 * WHATWG URL parsing normalises `::ffff:127.0.0.1` to the hex form
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
  // URL keeps IPv6 literals in brackets.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

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

/**
 * Validation message for a rejected URL. Separate from the predicate so the
 * Zod schema and any caller phrase it identically.
 */
export const BLOCKED_WEBHOOK_HOST_MESSAGE =
  'Webhook URL may not point at loopback or link-local addresses. Use an address reachable from the Vyzus container.';

/** True when the URL is well-formed and its host is allowed. */
export function isAllowedWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // shape is the URL validator's job; nothing to check here
  }
  return !isBlockedWebhookHost(parsed.hostname);
}
