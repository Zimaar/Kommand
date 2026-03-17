import { z } from 'zod';

const ChannelTypeSchema = z.enum(['whatsapp', 'slack', 'email', 'telegram']);

export const InboundMessageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channelType: ChannelTypeSchema,
  channelMessageId: z.string(),
  text: z.string(),
  timestamp: z.date(),
  metadata: z.record(z.unknown()).optional(),
});

export const OutboundMessageSchema = z.object({
  userId: z.string(),
  channelType: ChannelTypeSchema,
  text: z.string(),
  buttons: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
      })
    )
    .optional(),
  imageUrl: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type InboundMessageType = z.infer<typeof InboundMessageSchema>;
export type OutboundMessageType = z.infer<typeof OutboundMessageSchema>;
