export type ChannelType = 'whatsapp' | 'slack' | 'email' | 'telegram';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageRole = 'user' | 'assistant' | 'system';

export interface InboundMessage {
  readonly id: string;
  readonly userId: string;
  readonly channelType: ChannelType;
  readonly channelMessageId: string;
  readonly text: string;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  readonly userId: string;
  readonly channelType: ChannelType;
  readonly text: string;
  readonly buttons?: Array<{ readonly id: string; readonly title: string }>;
  readonly imageUrl?: string;
  readonly metadata?: Record<string, unknown>;
}
