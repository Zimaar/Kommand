import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AiBrain } from '../ai-brain.js';
import { ToolRegistry } from '../tool-registry.js';
import type { UserContext } from '../types.js';
import type { InboundMessage } from '@kommand/shared';

const mockMessage: InboundMessage = {
  id: 'msg-1',
  userId: 'user-1',
  channelType: 'whatsapp',
  channelMessageId: 'wamid-1',
  text: "How's my store doing today?",
  timestamp: new Date(),
};

const mockContext: UserContext = {
  userId: 'user-1',
  name: 'Ahmed',
  storeName: 'Test Store',
  currency: 'AED',
  timezone: 'Asia/Dubai',
  connectedTools: ['shopify'],
  plan: 'growth',
  conversationHistory: [],
};

function makeMockAnthropic(responseText: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe('AiBrain', () => {
  it('returns text response from Claude', async () => {
    const registry = new ToolRegistry();
    const anthropic = makeMockAnthropic('Revenue today is AED 12,450 ↑8% vs yesterday.');
    const brain = new AiBrain(anthropic, registry);

    const result = await brain.processMessage(mockMessage, mockContext);

    expect(result.text).toBe('Revenue today is AED 12,450 ↑8% vs yesterday.');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.tokensUsed).toBe(150);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('executes a tool and returns combined response', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_sales_summary',
      description: 'Get sales summary',
      inputSchema: { type: 'object', properties: { period: { type: 'string' } } },
      confirmationTier: 0,
      platform: 'shopify',
      handler: vi.fn().mockResolvedValue({ success: true, data: { revenue: 12450 } }),
    });

    let callCount = 0;
    const anthropic = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: Claude wants to use a tool
            return Promise.resolve({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_1',
                  name: 'get_sales_summary',
                  input: { period: 'today' },
                },
              ],
              model: 'claude-sonnet-4-6',
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 120, output_tokens: 30 },
            });
          }
          // Second call: Claude gives final answer
          return Promise.resolve({
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Revenue today is AED 12,450.' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 200, output_tokens: 40 },
          });
        }),
      },
    } as unknown as Anthropic;

    const brain = new AiBrain(anthropic, registry);
    const result = await brain.processMessage(mockMessage, mockContext);

    expect(result.text).toBe('Revenue today is AED 12,450.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('get_sales_summary');
    expect(result.toolCalls[0]?.result.success).toBe(true);
    expect(result.tokensUsed).toBe(390);
  });

  it('handles unknown tool gracefully', async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const anthropic = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu_1', name: 'nonexistent_tool', input: {} },
              ],
              model: 'claude-sonnet-4-6',
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 20 },
            });
          }
          return Promise.resolve({
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'I could not complete that action.' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 150, output_tokens: 25 },
          });
        }),
      },
    } as unknown as Anthropic;

    const brain = new AiBrain(anthropic, registry);
    const result = await brain.processMessage(mockMessage, mockContext);

    expect(result.toolCalls[0]?.result.success).toBe(false);
    expect(result.toolCalls[0]?.result.error).toContain('Unknown tool');
  });
});
