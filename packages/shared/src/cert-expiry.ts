// TLS certificate expiry evaluation, shared by both executors that can see a
// certificate: the `port` check's own TLS handshake, and the `http` check's
// navigation (Chromium reports the peer certificate via
// `response.securityDetails()`, so no second connection is needed).
//
// A certificate that has *already* expired is too late to be useful — by then
// browsers are refusing the site. The point of a warning window is to fail
// while there is still time to renew.
//
// Pure, so the rule is testable without a network or a clock.

const MS_PER_DAY = 86_400_000;

export interface CertExpiryVerdict {
  /**
   * Whole days until `validTo`. Floored, not rounded: a certificate with 13.6
   * days left has 13 usable days, and reporting 14 would let it slip past a
   * 14-day threshold unnoticed. Negative once expired.
   */
  daysUntilExpiry: number;
  /** True when a threshold is set and the certificate is inside it. */
  expiringSoon: boolean;
}

export function evaluateCertExpiry(validTo: Date, warningDays: number, now: Date = new Date()): CertExpiryVerdict {
  const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / MS_PER_DAY);
  return { daysUntilExpiry, expiringSoon: warningDays > 0 && daysUntilExpiry <= warningDays };
}

/**
 * Says how long is left and until when, so an alert is actionable without
 * opening the run.
 */
export function certExpiryMessage(target: string, daysLeft: number, validTo: Date | null, warningDays: number): string {
  const until = validTo ? ` (valid until ${validTo.toISOString()})` : '';
  if (daysLeft < 0) return `TLS certificate for ${target} expired ${-daysLeft} day(s) ago${until}`;
  if (daysLeft === 0) return `TLS certificate for ${target} expires today${until}`;
  return `TLS certificate for ${target} expires in ${daysLeft} day(s)${until} — warning threshold is ${warningDays} day(s)`;
}
