import Anthropic from '@anthropic-ai/sdk';
import type { InboundMessage } from '@kommand/shared';
import type { ToolRegistry } from './tool-registry.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { UserContext, AiBrainResponse, ToolCall } from './types.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 5;

export interface AiBrainConfig {
  maxTokens?: number;
}

export class AiBrain {
  constructor(
    private readonly anthropic: Anthropic,
    private readonly toolRegistry: ToolRegistry,
    private readonly config: AiBrainConfig = {}
  ) {}

  async processMessage(
    message: InboundMessage,
    context: UserContext
  ): Promise<AiBrainResponse> {
    const startTime = Date.now();
    const systemPrompt = buildSystemPrompt(context);
    const claudeTools = this.toolRegistry.getForClaude();
    const toolCallResults: ToolCall[] = [];

    // Build initial messages array: history + new user message
    const messages: Anthropic.MessageParam[] = [
      ...context.conversationHistory.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user' as const, content: message.text },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = '';

    // Multi-turn tool-use loop (max 5 iterations)
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.anthropic.messages.create({
        model: MODEL,
        max_tokens: this.config.maxTokens ?? 1024,
        system: systemPrompt,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Collect any tool_use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      // If no tool calls or stop reason is end_turn, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === 'text'
        );
        finalText = textBlock?.text ?? '';
        break;
      }

      // Add assistant message with tool_use blocks to messages
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const tool = this.toolRegistry.get(toolUse.name);

        if (!tool) {
          const result = { success: false, error: `Unknown tool: ${toolUse.name}` };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
          toolCallResults.push({ name: toolUse.name, input: toolUse.input, result });
          continue;
        }

        const toolContext = {
          userId: context.userId,
          currency: context.currency,
          timezone: context.timezone,
        };

        const result = await tool.handler(toolUse.input, toolContext);
        toolCallResults.push({ name: toolUse.name, input: toolUse.input, result });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Send all tool results back to Claude
      messages.push({ role: 'user', content: toolResults });
    }

    return {
      text: finalText,
      toolCalls: toolCallResults,
      tokensUsed: totalInputTokens + totalOutputTokens,
      latencyMs: Date.now() - startTime,
    };
  }
}
