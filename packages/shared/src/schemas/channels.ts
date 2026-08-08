import { z } from 'zod';
import { CHANNEL_TYPES, ALERT_EVENTS, DELIVERY_STATUSES } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';

export const channelTypeSchema = z.enum(CHANNEL_TYPES);

/** slack / discord / webhook — everything delivered by an HTTP POST. */
export const webhookChannelConfigSchema = z.object({
  url: z.string().url().max(2000),
  /** HMAC-SHA256 signing secret; generic `webhook` channels only. */
  secret: z.string().min(1).max(500).optional(),
});
export type WebhookChannelConfig = z.infer<typeof webhookChannelConfigSchema>;

/** `email` — delivered over SMTP, so no URL at all. */
export const emailChannelConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(587),
  /**
   * true = implicit TLS from the first byte (usually port 465). false = plain
   * connection upgraded with STARTTLS (usually 587), which is the common case
   * and therefore the default.
   */
  secure: z.boolean().default(false),
  username: z.string().min(1).max(320).optional(),
  password: z.string().min(1).max(500).optional(),
  from: z.string().email(),
  /** One channel, many recipients — matches how operators actually route mail. */
  to: z.array(z.string().email()).min(1).max(50),
});
export type EmailChannelConfig = z.infer<typeof emailChannelConfigSchema>;

/**
 * Stored in `alert_channels.config`. Deliberately a plain union rather than a
 * discriminated one: `alert_channels.type` is already the discriminant, and the
 * stored JSON has never carried a `kind` field. The column is `$type<>`-cast,
 * not parsed, on read — so existing rows are never re-validated and no data
 * migration is needed. Validation happens where `type` is present: the request
 * body, below.
 */
export const channelConfigSchema = z.union([webhookChannelConfigSchema, emailChannelConfigSchema]);
export type ChannelConfig = WebhookChannelConfig | EmailChannelConfig;

/** Narrows the stored union without repeating the key check at each call site. */
export function isEmailChannelConfig(c: ChannelConfig): c is EmailChannelConfig {
  return 'host' in c;
}

const channelBaseFields = {
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  allApps: z.boolean().default(true),
  // app ids to attach when allApps is false
  appIds: z.array(uuidSchema).max(500).default([]),
};

/**
 * Discriminated on `type`, so a `slack` channel cannot be created with SMTP
 * settings and an `email` channel cannot be created with a URL. This is why the
 * stored config needs no discriminant of its own.
 */
export const createChannelBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slack'), config: webhookChannelConfigSchema, ...channelBaseFields }),
  z.object({ type: z.literal('discord'), config: webhookChannelConfigSchema, ...channelBaseFields }),
  z.object({ type: z.literal('webhook'), config: webhookChannelConfigSchema, ...channelBaseFields }),
  z.object({ type: z.literal('email'), config: emailChannelConfigSchema, ...channelBaseFields }),
]);
export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

export const updateChannelBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    type: channelTypeSchema.optional(),
    config: channelConfigSchema.optional(),
    enabled: z.boolean().optional(),
    allApps: z.boolean().optional(),
    appIds: z.array(uuidSchema).max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty update' });
export type UpdateChannelBody = z.infer<typeof updateChannelBodySchema>;

/** Channel response — secrets are redacted to boolean flags, never returned. */
export const channelSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  type: channelTypeSchema,
  /** Webhook-family only; null for `email`, which has no URL. */
  url: z.string().nullable(),
  /** HMAC signing secret present (generic webhook channels). */
  hasSecret: z.boolean(),
  /**
   * SMTP password present. Deliberately separate from `hasSecret`: that one
   * means "requests to this webhook are signed", which is a different claim,
   * and conflating them would make the UI say something untrue.
   */
  hasPassword: z.boolean(),
  /**
   * Human-readable destination for the channel list, so the UI does not need a
   * branch per channel type: the URL for webhooks, `host:port -> recipients`
   * for email.
   */
  target: z.string(),
  enabled: z.boolean(),
  allApps: z.boolean(),
  appIds: z.array(uuidSchema),
  // NULL = admin/editor-managed global channel; otherwise the viewer who
  // owns this self-service channel (see docs/02-architecture.md §7 access).
  ownerId: uuidSchema.nullable(),
  // Who created this channel — always set (unlike ownerId), null only if
  // the creating user has since been deleted or the channel predates this
  // field.
  createdBy: uuidSchema.nullable(),
  createdByEmail: z.string().email().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Channel = z.infer<typeof channelSchema>;

export const channelListSchema = z.array(channelSchema);

export const testChannelResponseSchema = z.object({
  ok: z.boolean(),
  responseCode: z.number().int().nullable(),
});
export type TestChannelResponse = z.infer<typeof testChannelResponseSchema>;

export const alertDeliverySchema = z.object({
  id: uuidSchema,
  incidentId: uuidSchema.nullable(),
  channelId: uuidSchema,
  event: z.enum(ALERT_EVENTS),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  responseCode: z.number().int().nullable(),
  createdAt: isoTimestamp,
});
export type AlertDelivery = z.infer<typeof alertDeliverySchema>;

export const alertDeliveryListSchema = z.array(alertDeliverySchema);
