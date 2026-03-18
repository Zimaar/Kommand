import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationManager, type ConversationRepository, type MessageInput } from '../conversation-manager.js';
import type Anthropic from '@anthropic-ai/sdk';

// ─── In-memory repo ───────────────────────────────────────────────────────────

class InMemoryConversationRepo implements ConversationRepository {
  private convs = new Map<string, { userId: string; channelId: string; lastMessageAt: Date }>();
  private msgs = new Map<string, Array<{ id: string; role: string; content: string; createdAt: Date }>>();

  async findRecentConversation(userId: string, channelId: string, since: Date): Promise<string | null> {
    for (const [id, c] of this.convs.entries()) {
      if (c.userId === userId && c.channelId === channelId && c.lastMessageAt >= since) {
        return id;
      }
    }
    return null;
  }

  async createConversation(userId: string, channelId: string): Promise<string> {
    const id = crypto.randomUUID();
    this.convs.set(id, { userId, channelId, lastMessageAt: new Date() });
    this.msgs.set(id, []);
    return id;
  }

  async touchConversation(conversationId: string): Promise<void> {
    const c = this.convs.get(conversationId);
    if (c) c.lastMessageAt = new Date();
  }

  async insertMessage(conversationId: string, msg: MessageInput): Promise<string> {
    const id = crypto.randomUUID();
    const bucket = this.msgs.get(conversationId) ?? [];
    bucket.push({ id, role: msg.role, content: msg.content, createdAt: new Date() });
    this.msgs.set(conversationId, bucket);
    return id;
  }

  async getMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string; createdAt: Date }>> {
    const bucket = this.msgs.get(conversationId) ?? [];
    // Return most recent N (desc), caller reverses for chrono
    return [...bucket].reverse().slice(0, limit).map(({ role, content, createdAt }) => ({ role, content, createdAt }));
  }

  async countMessages(conversationId: string): Promise<number> {
    return this.msgs.get(conversationId)?.length ?? 0;
  }

  async getOldestMessages(conversationId: string, limit: number): Promise<Array<{ role: string; content: string }>> {
    const bucket = this.msgs.get(conversationId) ?? [];
    return bucket.slice(0, limit).map(({ role, content }) => ({ role, content }));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationManager', () => {
  let repo: InMemoryConversationRepo;
  let manager: ConversationManager;

  beforeEach(() => {
    repo = new InMemoryConversationRepo();
    manager = new ConversationManager(repo);
  });

  describe('getOrCreateConversation', () => {
    it('creates a new conversation on first call', async () => {
      const id = await manager.getOrCreateConversation('u1', 'ch1');
      expect(id).toBeTruthy();
    });

    it('returns the same conversation within 24h window', async () => {
      const id1 = await manager.getOrCreateConversation('u1', 'ch1');
      const id2 = await manager.getOrCreateConversation('u1', 'ch1');
      expect(id1).toBe(id2);
    });

    it('creates a new conversation for a different channel', async () => {
      const id1 = await manager.getOrCreateConversation('u1', 'ch1');
      const id2 = await manager.getOrCreateConversation('u1', 'ch2');
      expect(id1).not.toBe(id2);
    });
  });

  describe('addMessage + getHistory', () => {
    it('returns messages in chronological order (oldest first)', async () => {
      const convId = await manager.getOrCreateConversation('u1', 'ch1');
      await manager.addMessage(convId, { direction: 'inbound', role: 'user', content: 'msg 1' });
      await manager.addMessage(convId, { direction: 'outbound', role: 'assistant', content: 'msg 2' });
      await manager.addMessage(convId, { direction: 'inbound', role: 'user', content: 'msg 3' });
      await manager.addMessage(convId, { direction: 'outbound', role: 'assistant', content: 'msg 4' });
      await manager.addMessage(convId, { direction: 'inbound', role: 'user', content: 'msg 5' });

      const history = await manager.getHistory(convId);
      expect(history).toHaveLength(5);
      expect(history[0]!.content).toBe('msg 1');
      expect(history[4]!.content).toBe('msg 5');
    });

    it('respects the limit parameter', async () => {
      const convId = await manager.getOrCreateConversation('u1', 'ch1');
      for (let i = 1; i <= 8; i++) {
        const role = i % 2 === 1 ? 'user' : 'assistant';
        const dir = role === 'user' ? 'inbound' : 'outbound';
        await manager.addMessage(convId, { direction: dir, role, content: `msg ${i}` });
      }

      const history = await manager.getHistory(convId, 4);
      expect(history).toHaveLength(4);
      // Should be the 4 most recent, in chrono order
      expect(history[3]!.content).toBe('msg 8');
    });

    it('filters out system messages from history', async () => {
      const convId = await manager.getOrCreateConversation('u1', 'ch1');
      await manager.addMessage(convId, { direction: 'outbound', role: 'system', content: '[summary]' });
      await manager.addMessage(convId, { direction: 'inbound', role: 'user', content: 'hello' });
      await manager.addMessage(convId, { direction: 'outbound', role: 'assistant', content: 'hi there' });

      const history = await manager.getHistory(convId);
      expect(history).toHaveLength(2); // system message excluded by type contract
    });

    it('returns message IDs from addMessage', async () => {
      const convId = await manager.getOrCreateConversation('u1', 'ch1');
      const msgId = await manager.addMessage(convId, {
        direction: 'inbound',
        role: 'user',
        content: 'test',
      });
      expect(msgId).toBeTruthy();
    });
  });

  describe('getHistoryForContext', () => {
    it('creates conversation implicitly and returns empty history', async () => {
      const history = await manager.getHistoryForContext('u1', 'ch-new');
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });
  });

  describe('summarizeIfLong', () => {
    it('returns null when no anthropic client is provided', async () => {
      const convId = await manager.getOrCreateConversation('u1', 'ch1');
      expect(await manager.summarizeIfLong(convId)).toBeNull();
    });

    it('returns null when message count is below threshold (30)', async () => {
      const mockAnthropic = { messages: { create: vi.fn() } } as unknown as Anthropic;
      const mgr = new ConversationManager(repo, mockAnthropic);
      const convId = await mgr.getOrCreateConversation('u1', 'ch1');

      for (let i = 0; i < 20; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        await mgr.addMessage(convId, { direction: 'inbound', role, content: `msg ${i}` });
      }

      const result = await mgr.summarizeIfLong(convId);
      expect(result).toBeNull();
      expect((mockAnthropic.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('calls Claude and stores summary when > 30 messages', async () => {
      const mockAnthropic = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Business summary: owner asked about sales.' }],
          }),
        },
      } as unknown as Anthropic;

      const mgr = new ConversationManager(repo, mockAnthropic);
      const convId = await mgr.getOrCreateConversation('u1', 'ch1');

      // Add 35 messages
      for (let i = 0; i < 35; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        await mgr.addMessage(convId, { direction: 'inbound', role, content: `msg ${i}` });
      }

      const summary = await mgr.summarizeIfLong(convId);
      expect(summary).toBe('Business summary: owner asked about sales.');
      expect((mockAnthropic.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();

      // Verify the summary was stored as a system message
      const allMessages = await repo.getMessages(convId, 100);
      const systemMsg = allMessages.find((m) => m.role === 'system');
      expect(systemMsg).toBeTruthy();
      expect(systemMsg!.content).toContain('Business summary');
    });
  });
});
