import { eq, and, gt, desc, asc, count, inArray } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../db/connection.js';
import { conversations, messages } from '../db/schema.js';
import { CONVERSATION_HISTORY_LIMIT } from '../config/index.js';

const SUMMARIZE_THRESHOLD = 30;
const SUMMARIZE_FIRST_N = 20;
const CONVERSATION_WINDOW_HOURS = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MessageInput {
  direction: 'inbound' | 'outbound';
  role: 'user' | 'assistant' | 'system';
  content: string;
  channelMessageId?: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  tokensUsed?: number;
  latencyMs?: number;
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Repository interface (makes unit testing easy) ───────────────────────────

export interface ConversationRepository {
  findRecentConversation(userId: string, channelId: string, since: Date): Promise<string | null>;
  createConversation(userId: string, channelId: string): Promise<string>;
  touchConversation(conversationId: string): Promise<void>;
  insertMessage(conversationId: string, msg: MessageInput): Promise<string>;
  getMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string; createdAt: Date }>>;
  countMessages(conversationId: string): Promise<number>;
  getOldestMessages(conversationId: string, limit: number): Promise<Array<{ id: string; role: string; content: string }>>;
  deleteMessages(ids: string[]): Promise<void>;
}

// ─── Drizzle implementation ───────────────────────────────────────────────────

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: DB) {}

  async findRecentConversation(userId: string, channelId: string, since: Date): Promise<string | null> {
    const rows = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(
        eq(conversations.userId, userId),
        eq(conversations.channelId, channelId),
        gt(conversations.lastMessageAt, since),
      ))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async createConversation(userId: string, channelId: string): Promise<string> {
    const [row] = await this.db
      .insert(conversations)
      .values({ userId, channelId })
      .returning({ id: conversations.id });
    return row!.id;
  }

  async touchConversation(conversationId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }

  async insertMessage(conversationId: string, msg: MessageInput): Promise<string> {
    const [row] = await this.db
      .insert(messages)
      .values({
        conversationId,
        direction: msg.direction,
        role: msg.role,
        content: msg.content,
        channelMessageId: msg.channelMessageId,
        toolCalls: msg.toolCalls ?? null,
        toolResults: msg.toolResults ?? null,
        tokensUsed: msg.tokensUsed,
        latencyMs: msg.latencyMs,
      })
      .returning({ id: messages.id });
    return row!.id;
  }

  async getMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string; createdAt: Date }>> {
    const rows = await this.db
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows;
  }

  async countMessages(conversationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    return Number(row?.value ?? 0);
  }

  async getOldestMessages(conversationId: string, limit: number): Promise<Array<{ id: string; role: string; content: string }>> {
    return this.db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
  }

  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.delete(messages).where(inArray(messages.id, ids));
  }
}

// ─── ConversationManager ──────────────────────────────────────────────────────

export class ConversationManager {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly anthropic?: Anthropic
  ) {}

  /** Factory for production use — wraps a Drizzle DB instance. */
  static fromDb(db: DB, anthropic?: Anthropic): ConversationManager {
    return new ConversationManager(new DrizzleConversationRepository(db), anthropic);
  }

  async getOrCreateConversation(userId: string, channelId: string): Promise<string> {
    const since = new Date(Date.now() - CONVERSATION_WINDOW_HOURS * 3_600_000);
    const existing = await this.repo.findRecentConversation(userId, channelId, since);
    if (existing) return existing;
    return this.repo.createConversation(userId, channelId);
  }

  async addMessage(conversationId: string, message: MessageInput): Promise<string> {
    const id = await this.repo.insertMessage(conversationId, message);
    await this.repo.touchConversation(conversationId);
    return id;
  }

  async getHistory(
    conversationId: string,
    limit: number = CONVERSATION_HISTORY_LIMIT
  ): Promise<HistoryEntry[]> {
    const rows = await this.repo.getMessages(conversationId, limit);
    return rows
      .filter((r): r is typeof r & { role: 'user' | 'assistant' } =>
        r.role === 'user' || r.role === 'assistant'
      )
      .reverse()
      .map(({ role, content }) => ({ role, content }));
  }

  async getHistoryForContext(userId: string, channelId: string): Promise<HistoryEntry[]> {
    const conversationId = await this.getOrCreateConversation(userId, channelId);
    return this.getHistory(conversationId);
  }

  async summarizeIfLong(conversationId: string): Promise<string | null> {
    if (!this.anthropic) return null;

    const total = await this.repo.countMessages(conversationId);
    if (total <= SUMMARIZE_THRESHOLD) return null;

    const oldMessages = await this.repo.getOldestMessages(conversationId, SUMMARIZE_FIRST_N);
    const transcript = oldMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation in 2-3 sentences, capturing key business context and decisions:\n\n${transcript}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const summary = block.text;

    await this.repo.insertMessage(conversationId, {
      direction: 'outbound',
      role: 'system',
      content: `[Conversation summary]: ${summary}`,
    });

    // Prune the messages that were just summarised so the conversation doesn't grow unboundedly
    await this.repo.deleteMessages(oldMessages.map((m) => m.id));

    return summary;
  }
}
