import type { ToolResult } from '@kommand/shared';

export interface UserContext {
  userId: string;
  name: string;
  storeName: string;
  currency: string;
  timezone: string;
  connectedTools: string[];
  plan: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ToolCall {
  name: string;
  input: unknown;
  result: ToolResult;
}

export interface AiBrainResponse {
  text: string;
  toolCalls: ToolCall[];
  tokensUsed: number;
  latencyMs: number;
}
