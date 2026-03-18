import { eq, and } from 'drizzle-orm';
import type { InboundMessage } from '@kommand/shared';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_MESSAGE_LENGTH } from '../config/index.js';
import { handlePipelineError } from '../core/error-handler.js';
import type { ChannelAdapter } from './adapter.interface.js';
import { getAdapter } from './factory.js';
import type { DB } from '../db/connection.js';
import { users, stores, accountingConnections, channels } from '../db/schema.js';
import type { AiBrain } from '../core/ai-brain.js';
import type { ConversationManager } from '../core/conversation-manager.js';
import type { ConfirmationEngine } from '../core/confirmation-engine.js';
import type { ToolDispatcher } from '../core/tool-dispatcher.js';
import { responseFormatter } from '../core/response-formatter.js';
import type { UserContext } from '../core/types.js';
import { getRedisClient } from '../utils/redis.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineDeps {
  db: DB;
  aiBrain: AiBrain;
  conversationManager: ConversationManager;
  confirmationEngine: ConfirmationEngine;
  toolDispatcher: ToolDispatcher;
}

// Simple in-memory queue — will be replaced with BullMQ in M6
type QueueJob = { channelType: string; raw: unknown };
const queue: QueueJob[] = [];
let isProcessing = false;

// ─── MessageIngestionService ──────────────────────────────────────────────────

export class MessageIngestionService {
  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly deps?: PipelineDeps
  ) {}

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
        // Best-effort: try to send a friendly error back via the adapter
        try {
          const adapter = getAdapter(job.channelType);
          const raw = job.raw as Record<string, unknown>;
          const userId = (raw['userId'] as string) ?? 'unknown';
          const outbound = handlePipelineError(err, userId, job.channelType);
          await adapter.send(adapter.formatOutbound(outbound));
        } catch {
          // Swallow — nothing more we can do
        }
      }
    }
    isProcessing = false;
  }

  async processInbound(channelType: string, rawBody: unknown): Promise<void> {
    const adapter = getAdapter(channelType);

    // a. Normalize raw body → InboundMessage
    const message = adapter.parseInbound(rawBody);

    // b. Deduplicate via Redis SET NX (1hr TTL)
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

    // No deps wired (dev/test without DB) — send acknowledgement and stop
    if (!this.deps) {
      await this.sendAcknowledgement(channelType, truncated, adapter);
      return;
    }

    const { db, aiBrain, conversationManager, confirmationEngine, toolDispatcher } = this.deps;

    // d. Resolve userId → DB user
    // For WhatsApp, truncated.userId is a normalised phone number. Resolve it
    // to the owner's UUID via the channels table before doing the user lookup.
    let resolvedUserId = truncated.userId;
    if (truncated.channelType === 'whatsapp') {
      const waChannel = await db
        .select({ userId: channels.userId })
        .from(channels)
        .where(and(eq(channels.channelId, truncated.userId), eq(channels.type, 'whatsapp')))
        .limit(1);

      if (waChannel.length === 0) {
        this.logger.warn(
          { phone: truncated.userId },
          'No WhatsApp channel registered for this phone — user not onboarded yet'
        );
        return;
      }
      resolvedUserId = waChannel[0]!.userId;
    }

    const userRows = await db
      .select({ id: users.id, name: users.name, timezone: users.timezone, plan: users.plan })
      .from(users)
      .where(eq(users.id, resolvedUserId))
      .limit(1);

    if (userRows.length === 0) {
      this.logger.warn({ userId: resolvedUserId }, 'User not found in DB, skipping pipeline');
      return;
    }

    const user = userRows[0]!;

    // Fetch active stores (storeName + connectedTools) in one query
    const storeRows = await db
      .select({ shopName: stores.shopName, platform: stores.platform })
      .from(stores)
      .where(and(eq(stores.userId, user.id), eq(stores.isActive, true)));

    const accountingRows = await db
      .select({ platform: accountingConnections.platform })
      .from(accountingConnections)
      .where(and(eq(accountingConnections.userId, user.id), eq(accountingConnections.isActive, true)));

    const storeName = storeRows[0]?.shopName ?? '';
    const connectedTools = [
      ...storeRows.map((s) => s.platform),
      ...accountingRows.map((a) => a.platform),
    ];

    // e. Look up channel record and store inbound message
    // Best-effort: if no channel row in DB (e.g. mock), skip persistence but continue
    const channelRows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.userId, user.id),
          eq(channels.type, channelType as 'whatsapp' | 'slack' | 'email' | 'telegram')
        )
      )
      .limit(1);

    let conversationId: string | null = null;
    if (channelRows.length > 0) {
      conversationId = await conversationManager.getOrCreateConversation(user.id, channelRows[0]!.id);
      await conversationManager.addMessage(conversationId, {
        direction: 'inbound',
        role: 'user',
        content: truncated.text,
        channelMessageId: truncated.channelMessageId,
      });
    }

    // f. Check if this message is a reply to a pending confirmation
    const confResult = await confirmationEngine.handleResponse(
      truncated.userId,
      truncated.text,
      (confId, ctx) => toolDispatcher.executeConfirmed(confId, ctx)
    );

    if (confResult.handled) {
      const responseText = confResult.message
        ?? (confResult.result?.success
          ? (typeof confResult.result.data === 'string'
              ? confResult.result.data
              : JSON.stringify(confResult.result.data))
          : `❌ ${confResult.result?.error ?? 'Action failed'}`);
      await this.sendAndStore(channelType, truncated.userId, responseText, conversationId, conversationManager, adapter);
      return;
    }

    // g. Build UserContext and pass to AI Brain
    const history = conversationId ? await conversationManager.getHistory(conversationId) : [];

    const userCtx: UserContext = {
      userId: user.id,
      name: user.name ?? '',
      storeName,
      currency: 'USD', // resolved from store settings in M3
      timezone: user.timezone,
      connectedTools,
      plan: user.plan,
      conversationHistory: history,
    };

    const brainResponse = await aiBrain.processMessage(truncated, userCtx);

    // h. Store outbound message and send via adapter
    await this.sendAndStore(
      channelType,
      truncated.userId,
      brainResponse.text || '(no response)',
      conversationId,
      conversationManager,
      adapter,
      { tokensUsed: brainResponse.tokensUsed, latencyMs: brainResponse.latencyMs }
    );
  }

  private async sendAndStore(
    channelType: string,
    userId: string,
    text: string,
    conversationId: string | null,
    conversationManager: ConversationManager,
    adapter: ChannelAdapter,
    metrics?: { tokensUsed: number; latencyMs: number }
  ): Promise<void> {
    if (conversationId) {
      await conversationManager.addMessage(conversationId, {
        direction: 'outbound',
        role: 'assistant',
        content: text,
        tokensUsed: metrics?.tokensUsed,
        latencyMs: metrics?.latencyMs,
      });
    }

    const outbound = responseFormatter.formatForChannel(text, channelType);
    const formatted = adapter.formatOutbound({ ...outbound, userId });
    await adapter.send(formatted);
  }

  private async checkDuplicate(channelMessageId: string): Promise<boolean> {
    try {
      const redis = getRedisClient();
      const key = `dedup:msg:${channelMessageId}`;
      // SET NX EX 3600 — returns 'OK' if new, null if key already existed
      const result = await redis.set(key, '1', 'EX', 3600, 'NX');
      return result === null;
    } catch {
      this.logger.warn('Redis unavailable for dedup, processing message anyway');
      return false;
    }
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
