import type { InboundMessage, OutboundMessage } from '@kommand/shared';

export interface ChannelAdapter {
  parseInbound(raw: unknown): InboundMessage;
  formatOutbound(msg: OutboundMessage): unknown;
  send(formatted: unknown): Promise<void>;
}
