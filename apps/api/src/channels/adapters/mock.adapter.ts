import type { InboundMessage, OutboundMessage } from '@kommand/shared';
import type { ChannelAdapter } from '../adapter.interface.js';

export class MockAdapter implements ChannelAdapter {
  parseInbound(raw: unknown): InboundMessage {
    // Cast raw to a plain object for testing
    const body = raw as Record<string, unknown>;
    return {
      id: (body['id'] as string) ?? crypto.randomUUID(),
      userId: (body['userId'] as string) ?? 'mock-user-id',
      channelType: 'whatsapp',
      channelMessageId: (body['channelMessageId'] as string) ?? crypto.randomUUID(),
      text: (body['text'] as string) ?? '',
      timestamp: new Date(),
      metadata: body['metadata'] as Record<string, unknown> | undefined,
    };
  }

  formatOutbound(msg: OutboundMessage): unknown {
    return {
      to: msg.userId,
      type: 'text',
      text: { body: msg.text },
      buttons: msg.buttons,
      imageUrl: msg.imageUrl,
    };
  }

  async send(formatted: unknown): Promise<void> {
    console.log('[MockAdapter] Sending outbound message:', JSON.stringify(formatted, null, 2));
  }
}
