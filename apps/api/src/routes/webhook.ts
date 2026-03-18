import { eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../utils/errors.js';
import { MessageIngestionService, type PipelineDeps } from '../channels/ingestion.js';
import { db } from '../db/connection.js';
import { commands } from '../db/schema.js';
import type { DB } from '../db/connection.js';
import type { CommandStore } from '../core/tool-dispatcher.js';
import { ToolDispatcher } from '../core/tool-dispatcher.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { AiBrain } from '../core/ai-brain.js';
import { ConversationManager } from '../core/conversation-manager.js';
import { DbConfirmationEngine } from '../core/confirmation-engine.js';
import { registerAllShopifyTools } from '../tools/shopify/shopify-tools.js';
import { config } from '../config/index.js';

const KNOWN_CHANNEL_TYPES = new Set(['whatsapp', 'slack', 'email', 'telegram']);

// ─── DB-backed CommandStore ───────────────────────────────────────────────────

class DbCommandStore implements CommandStore {
  constructor(private readonly db: DB) {}

  async findByIdempotencyKey(key: string): Promise<{ output: unknown } | null> {
    const rows = await this.db
      .select({ output: commands.output })
      .from(commands)
      .where(eq(commands.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(opts: Parameters<CommandStore['create']>[0]): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(commands)
      .values({
        userId: opts.userId,
        toolName: opts.toolName,
        commandType: opts.commandType,
        input: opts.input,
        status: opts.status,
        confirmationTier: opts.confirmationTier,
        idempotencyKey: opts.idempotencyKey,
      })
      .returning({ id: commands.id });
    return { id: row!.id };
  }

  async update(id: string, opts: Parameters<CommandStore['update']>[1]): Promise<void> {
    await this.db
      .update(commands)
      .set({
        status: opts.status as 'pending' | 'confirmed' | 'executed' | 'failed' | 'cancelled',
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.error !== undefined ? { error: opts.error } : {}),
        ...(opts.executedAt !== undefined ? { executedAt: opts.executedAt } : {}),
      })
      .where(eq(commands.id, id));
  }
}

// ─── Pipeline factory ─────────────────────────────────────────────────────────

export function buildPipelineDeps(): PipelineDeps {
  const registry = new ToolRegistry();
  registerAllShopifyTools(db, registry);

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const aiBrain = new AiBrain(anthropic, registry);
  const conversationManager = ConversationManager.fromDb(db, anthropic);
  const confirmationEngine = new DbConfirmationEngine(db);
  const commandStore = new DbCommandStore(db);
  const toolDispatcher = new ToolDispatcher(registry, confirmationEngine, commandStore);

  return { db, aiBrain, conversationManager, confirmationEngine, toolDispatcher };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function webhookRoutes(app: FastifyInstance, ingestion: MessageIngestionService) {

  app.post<{ Params: { channelType: string } }>(
    '/webhook/:channelType',
    async (request, reply) => {
      const { channelType } = request.params;

      if (!KNOWN_CHANNEL_TYPES.has(channelType)) {
        throw AppError.validationError(`Unknown channel type: ${channelType}`);
      }

      // Enqueue for async processing — return 200 immediately
      ingestion.enqueue(channelType, request.body);

      return reply.status(200).send({ received: true });
    }
  );
}
