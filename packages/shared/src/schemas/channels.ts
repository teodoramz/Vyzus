import { z } from 'zod';
import { CHANNEL_TYPES, ALERT_EVENTS, DELIVERY_STATUSES } from '../constants.js';
import { isoTimestamp, uuidSchema } from './common.js';

export const channelTypeSchema = z.enum(CHANNEL_TYPES);

export const channelConfigSchema = z.object({
  url: z.string().url().max(2000),
  secret: z.string().min(1).max(500).optional(),
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const createChannelBodySchema = z.object({
  name: z.string().min(1).max(200),
  type: channelTypeSchema,
  config: channelConfigSchema,
  enabled: z.boolean().default(true),
  allApps: z.boolean().default(true),
  // app ids to attach when allApps is false
  appIds: z.array(uuidSchema).max(500).default([]),
});
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

/** Channel response — `secret` is redacted to a boolean flag. */
export const channelSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  type: channelTypeSchema,
  url: z.string(),
  hasSecret: z.boolean(),
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
