import type { InboundMessage } from '@kommand/shared';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_MESSAGE_LENGTH } from '../config/index.js';
import type { ChannelAdapter } from './adapter.interface.js';
import { MockAdapter } from './adapters/mock.adapter.js';

// Simple in-memory queue — will be replaced with BullMQ in M6
type QueueJob = { channelType: string; raw: unknown };
const queue: QueueJob[] = [];
let isProcessing = false;

const adapters: Record<string, ChannelAdapter> = {
  whatsapp: new MockAdapter(),
  slack: new MockAdapter(),
  email: new MockAdapter(),
  telegram: new MockAdapter(),
};

export class MessageIngestionService {
  constructor(private readonly logger: FastifyBaseLogger) {}

  /**
   * Enqueue inbound message for async processing.
   * Webhook returns 200 immediately; processing happens in background.
   */
  enqueue(channelType: string, rawBody: unknown): void {
    queue.push({ channelType, raw: rawBody });
    if (!isProcessing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    isProcessing = true;
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        await this.processInbound(job.channelType, job.raw);
      } catch (err) {
        this.logger.error({ err, job }, 'Failed to process inbound message');
      }
    }
    isProcessing = false;
  }

  async processInbound(channelType: string, rawBody: unknown): Promise<void> {
    const adapter = adapters[channelType] ?? adapters['whatsapp']!;

    // a. Normalize raw body → InboundMessage
    const message = adapter.parseInbound(rawBody);

    // b. Deduplicate (placeholder — Redis dedup wired in M2 once Redis client is bootstrapped)
    const isDuplicate = await this.checkDuplicate(message.channelMessageId);
    if (isDuplicate) {
      this.logger.info({ channelMessageId: message.channelMessageId }, 'Duplicate message, skipping');
      return;
    }

    // c. Truncate to MAX_MESSAGE_LENGTH
    const truncated: InboundMessage = {
      ...message,
      text: message.text.slice(0, MAX_MESSAGE_LENGTH),
    };

    this.logger.info(
      { userId: truncated.userId, channelType, channelMessageId: truncated.channelMessageId },
      'Processing inbound message'
    );

    // d. Look up user by channel info (placeholder — DB lookup in M2)
    // e. Store message in DB (placeholder — M2)
    // f. Check for pending confirmations (placeholder — M3)
    // g. Pass to AI Brain (placeholder — M2)
    // h. Send response via outbound adapter
    await this.sendAcknowledgement(channelType, truncated, adapter);
  }

  private async checkDuplicate(_channelMessageId: string): Promise<boolean> {
    // Placeholder: Redis SET NX with 1hr TTL will be added in M2
    return false;
  }

  private async sendAcknowledgement(
    _channelType: string,
    message: InboundMessage,
    adapter: ChannelAdapter
  ): Promise<void> {
    const outbound = {
      userId: message.userId,
      channelType: message.channelType,
      text: '✅ Message received — processing...',
    };
    const formatted = adapter.formatOutbound(outbound);
    await adapter.send(formatted);
  }
}
