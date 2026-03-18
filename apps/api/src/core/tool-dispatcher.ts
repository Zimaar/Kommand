import crypto from 'node:crypto';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { ToolRegistry } from './tool-registry.js';
import type { ConfirmationEngine } from './confirmation-engine.js';

export interface CommandStore {
  findByIdempotencyKey(key: string): Promise<{ output: unknown } | null>;
  create(opts: {
    userId: string;
    toolName: string;
    commandType: string;
    input: unknown;
    status: 'pending' | 'executed';
    confirmationTier: number;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  update(id: string, opts: { status: string; output?: unknown; error?: string; executedAt?: Date }): Promise<void>;
}

function buildIdempotencyKey(userId: string, toolName: string, params: unknown): string {
  const hourSlot = new Date();
  hourSlot.setMinutes(0, 0, 0);
  const raw = `${userId}:${toolName}:${JSON.stringify(params)}:${hourSlot.toISOString()}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildConfirmationPrompt(toolName: string, params: unknown, tier: number): string {
  const paramsStr = JSON.stringify(params, null, 2);
  switch (tier) {
    case 1:
      return `Confirm: run **${toolName}**?\n${paramsStr}`;
    case 2:
      return `This action will modify data. Confirm **${toolName}** with:\n${paramsStr}`;
    case 3:
      return `⚠️ High-risk action. Type CONFIRM to execute **${toolName}** with:\n${paramsStr}`;
    default:
      return `Confirm ${toolName}`;
  }
}

export class ToolDispatcher {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly confirmationEngine: ConfirmationEngine,
    private readonly commandStore: CommandStore
  ) {}

  async dispatch(
    toolName: string,
    params: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    // Idempotency check
    const idempotencyKey = buildIdempotencyKey(context.userId, toolName, params);
    const existing = await this.commandStore.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing.output as ToolResult;
    }

    // Tier 1-3: requires confirmation
    if (tool.confirmationTier > 0) {
      const command = await this.commandStore.create({
        userId: context.userId,
        toolName,
        commandType: tool.platform,
        input: params,
        status: 'pending',
        confirmationTier: tool.confirmationTier,
        idempotencyKey,
      });

      const promptText = buildConfirmationPrompt(toolName, params, tool.confirmationTier);
      const confirmation = await this.confirmationEngine.create({
        userId: context.userId,
        commandId: command.id,
        toolName,
        params,
        context,
        promptText,
      });

      return {
        success: true,
        data: {
          requiresConfirmation: true,
          confirmationId: confirmation.id,
          promptText,
          tier: tool.confirmationTier,
        },
      };
    }

    // Tier 0: execute immediately
    return this.executeWithLogging(toolName, params, context, idempotencyKey);
  }

  async executeConfirmed(
    confirmationId: string,
    context: ToolContext
  ): Promise<ToolResult> {
    const confirmation = await this.confirmationEngine.get(confirmationId);
    if (!confirmation) {
      return { success: false, error: 'Confirmation not found or expired' };
    }

    const result = await this.executeWithLogging(
      confirmation.toolName,
      confirmation.params,
      confirmation.context ?? context,
      buildIdempotencyKey(context.userId, confirmation.toolName, confirmation.params)
    );

    await this.commandStore.update(confirmation.commandId, {
      status: 'executed',
      output: result,
      executedAt: new Date(),
    });

    await this.confirmationEngine.complete(confirmationId);

    return result;
  }

  private async executeWithLogging(
    toolName: string,
    params: unknown,
    context: ToolContext,
    idempotencyKey: string
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName)!;

    const command = await this.commandStore.create({
      userId: context.userId,
      toolName,
      commandType: tool.platform,
      input: params,
      status: 'pending',
      confirmationTier: tool.confirmationTier,
      idempotencyKey,
    });

    try {
      const result = await tool.handler(params, context);

      await this.commandStore.update(command.id, {
        status: 'executed',
        output: result,
        executedAt: new Date(),
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      await this.commandStore.update(command.id, {
        status: 'failed',
        error: message,
      });

      // In production this would also call Sentry
      console.error(`[ToolDispatcher] Tool "${toolName}" failed:`, err);

      return {
        success: false,
        error: `The ${toolName} action could not be completed. Please try again.`,
      };
    }
  }
}
