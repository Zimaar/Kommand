import { eq, lt, gt, and, desc } from 'drizzle-orm';
import type { ToolContext, ToolResult } from '@kommand/shared';
import { CONFIRMATION_TIMEOUT_MS } from '../config/index.js';
import type { DB } from '../db/connection.js';
import { pendingConfirmations, commands, users } from '../db/schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingConfirmationRecord {
  id: string;
  userId: string;
  commandId: string;
  toolName: string;
  params: unknown;
  context: ToolContext;
  promptText: string;
  tier: number;
  expiresAt: Date;
}

export interface HandleResponseResult {
  handled: boolean;
  result?: ToolResult;
  message?: string;
}

// Minimal interface the dispatcher needs
export interface ConfirmationEngine {
  create(opts: {
    userId: string;
    commandId: string;
    toolName: string;
    params: unknown;
    context: ToolContext;
    promptText: string;
    tier?: number;
  }): Promise<PendingConfirmationRecord>;

  get(confirmationId: string): Promise<PendingConfirmationRecord | null>;
  complete(confirmationId: string): Promise<void>;

  // Full engine methods
  handleResponse(
    userId: string,
    responseText: string,
    execute: (confirmationId: string, context: ToolContext) => Promise<ToolResult>
  ): Promise<HandleResponseResult>;

  cleanupExpired(): Promise<number>;

  getPromptText(toolName: string, params: unknown, tier: number, context: ToolContext): string;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseConfirmationResponse(text: string, tier: number): 'confirmed' | 'cancelled' | null {
  const trimmed = text.trim();
  if (tier === 3) {
    return trimmed.toUpperCase() === 'CONFIRM' ? 'confirmed'
      : /^(no|n|cancel|0)$/i.test(trimmed) ? 'cancelled'
      : null;
  }
  if (/^(yes|y|confirm|1)$/i.test(trimmed)) return 'confirmed';
  if (/^(no|n|cancel|0)$/i.test(trimmed)) return 'cancelled';
  return null;
}

// ─── Prompt text builder ──────────────────────────────────────────────────────

export function getPromptText(toolName: string, params: unknown, tier: number, _context: ToolContext): string {
  const p = params as Record<string, unknown>;

  switch (tier) {
    case 1: {
      if (toolName === 'send_invoice') {
        return `Send invoice **${p['invoice_number'] ?? ''}** to the contact?\n*(Yes/No)*`;
      }
      if (toolName === 'send_invoice_reminder') {
        return `Send payment reminder for invoice **${p['invoice_number'] ?? ''}**?\n*(Yes/No)*`;
      }
      if (toolName === 'create_invoice') {
        const lineItems = (p['line_items'] as Array<{ quantity: number; unit_amount: number }> | undefined) ?? [];
        const total = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_amount, 0);
        const itemCount = lineItems.length;
        const dueStr = p['due_date'] ? `, due **${p['due_date']}**` : '';
        return `Create invoice for **${p['contact_name'] ?? ''}** — ${total.toFixed(2)} (${itemCount} item${itemCount !== 1 ? 's' : ''})${dueStr}?\n*(Yes/No)*`;
      }
      if (toolName === 'approve_bill') {
        return `Approve bill **${p['bill_id'] ?? ''}** for payment?\n*(Yes/No)*`;
      }
      if (toolName === 'fulfill_order') {
        return `Mark order ${p['order_identifier'] ?? ''} as fulfilled?\n*(Yes/No)*`;
      }
      if (toolName === 'create_discount') {
        return `Create discount code **${p['code'] ?? ''}** (${p['type']} - ${p['value']})?\n*(Yes/No)*`;
      }
      return `Confirm: **${toolName}**\n\`\`\`\n${JSON.stringify(params, null, 2)}\n\`\`\`\n*(Yes/No)*`;
    }

    case 2: {
      if (toolName === 'refund_order') {
        const amount = p['amount'] ? `$${p['amount']}` : 'full amount';
        return `Refund ${amount} for order **${p['order_identifier'] ?? ''}**?\n  Reason: ${p['reason'] ?? 'Customer request'}\n  Method: Original payment\n*(Yes/No)*`;
      }
      if (toolName === 'cancel_order') {
        return `Cancel order **${p['order_identifier'] ?? ''}**?\n  Restock items: ${p['restock'] ? 'Yes' : 'No'}\n*(Yes/No)*`;
      }
      if (toolName === 'update_product_price') {
        return `Change price of **${p['product_name'] ?? ''}** to **${p['new_price']}**?\n*(Yes/No)*`;
      }
      return `This action will modify data. Confirm **${toolName}**:\n\`\`\`\n${JSON.stringify(params, null, 2)}\n\`\`\`\n*(Yes/No)*`;
    }

    case 3: {
      return `⚠️ High-risk action: **${toolName}**\n\`\`\`\n${JSON.stringify(params, null, 2)}\n\`\`\`\n*Type CONFIRM to proceed or No to cancel.*`;
    }

    default:
      return `Confirm: ${toolName}`;
  }
}

// ─── In-memory implementation (tests + dev) ────────────────────────────────

export class InMemoryConfirmationEngine implements ConfirmationEngine {
  private readonly store = new Map<string, PendingConfirmationRecord>();

  async create(opts: {
    userId: string;
    commandId: string;
    toolName: string;
    params: unknown;
    context: ToolContext;
    promptText: string;
    tier?: number;
  }): Promise<PendingConfirmationRecord> {
    const record: PendingConfirmationRecord = {
      id: crypto.randomUUID(),
      tier: opts.tier ?? 1,
      expiresAt: new Date(Date.now() + CONFIRMATION_TIMEOUT_MS),
      ...opts,
    };
    this.store.set(record.id, record);
    return record;
  }

  async get(confirmationId: string): Promise<PendingConfirmationRecord | null> {
    const record = this.store.get(confirmationId);
    if (!record) return null;
    if (record.expiresAt <= new Date()) {
      this.store.delete(confirmationId);
      return null;
    }
    return record;
  }

  async complete(confirmationId: string): Promise<void> {
    this.store.delete(confirmationId);
  }

  async handleResponse(
    userId: string,
    responseText: string,
    execute: (confirmationId: string, context: ToolContext) => Promise<ToolResult>
  ): Promise<HandleResponseResult> {
    // Find the latest pending confirmation for this user
    const pending = Array.from(this.store.values())
      .filter((r) => r.userId === userId && r.expiresAt > new Date())
      .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];

    if (!pending) return { handled: false };

    const decision = parseConfirmationResponse(responseText, pending.tier);
    if (decision === null) return { handled: false };

    if (decision === 'cancelled') {
      this.store.delete(pending.id);
      return { handled: true, message: '❌ Action cancelled.' };
    }

    // Confirmed — execute
    const result = await execute(pending.id, pending.context);
    return { handled: true, result };
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, record] of this.store.entries()) {
      if (record.expiresAt <= now) {
        this.store.delete(id);
        count++;
      }
    }
    return count;
  }

  getPromptText(toolName: string, params: unknown, tier: number, context: ToolContext): string {
    return getPromptText(toolName, params, tier, context);
  }
}

// ─── DB-backed implementation (production) ────────────────────────────────────

export class DbConfirmationEngine implements ConfirmationEngine {
  constructor(private readonly db: DB) {}

  async create(opts: {
    userId: string;
    commandId: string;
    channelId?: string;
    toolName: string;
    params: unknown;
    context: ToolContext;
    promptText: string;
    tier?: number;
  }): Promise<PendingConfirmationRecord> {
    const expiresAt = new Date(Date.now() + CONFIRMATION_TIMEOUT_MS);

    const [row] = await this.db
      .insert(pendingConfirmations)
      .values({
        userId: opts.userId,
        commandId: opts.commandId,
        channelId: opts.channelId ?? opts.userId, // fallback; real channelId injected in M3
        promptText: opts.promptText,
        expiresAt,
        status: 'pending',
      })
      .returning();

    return {
      id: row!.id,
      userId: opts.userId,
      commandId: opts.commandId,
      toolName: opts.toolName,
      params: opts.params,
      context: opts.context,
      promptText: opts.promptText,
      tier: opts.tier ?? 1,
      expiresAt,
    };
  }

  async get(confirmationId: string): Promise<PendingConfirmationRecord | null> {
    const rows = await this.db
      .select({
        id: pendingConfirmations.id,
        userId: pendingConfirmations.userId,
        commandId: pendingConfirmations.commandId,
        promptText: pendingConfirmations.promptText,
        expiresAt: pendingConfirmations.expiresAt,
        status: pendingConfirmations.status,
        toolName: commands.toolName,
        params: commands.input,
        tier: commands.confirmationTier,
        timezone: users.timezone,
      })
      .from(pendingConfirmations)
      .innerJoin(commands, eq(pendingConfirmations.commandId, commands.id))
      .innerJoin(users, eq(pendingConfirmations.userId, users.id))
      .where(eq(pendingConfirmations.id, confirmationId))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;
    if (row.status !== 'pending' || row.expiresAt <= new Date()) return null;

    return {
      id: row.id,
      userId: row.userId,
      commandId: row.commandId,
      toolName: row.toolName,
      params: row.params,
      // currency not yet in DB; resolved from store settings in M3
      context: { userId: row.userId, timezone: row.timezone, currency: 'USD' },
      promptText: row.promptText,
      tier: row.tier,
      expiresAt: row.expiresAt,
    };
  }

  async complete(confirmationId: string): Promise<void> {
    await this.db
      .update(pendingConfirmations)
      .set({ status: 'confirmed' })
      .where(eq(pendingConfirmations.id, confirmationId));
  }

  async handleResponse(
    userId: string,
    responseText: string,
    execute: (confirmationId: string, context: ToolContext) => Promise<ToolResult>
  ): Promise<HandleResponseResult> {
    const now = new Date();
    const rows = await this.db
      .select({
        id: pendingConfirmations.id,
        userId: pendingConfirmations.userId,
        tier: commands.confirmationTier,
        timezone: users.timezone,
      })
      .from(pendingConfirmations)
      .innerJoin(commands, eq(pendingConfirmations.commandId, commands.id))
      .innerJoin(users, eq(pendingConfirmations.userId, users.id))
      .where(
        and(
          eq(pendingConfirmations.userId, userId),
          eq(pendingConfirmations.status, 'pending'),
          gt(pendingConfirmations.expiresAt, now)
        )
      )
      .orderBy(desc(pendingConfirmations.createdAt))
      .limit(1);

    if (rows.length === 0) return { handled: false };

    const row = rows[0]!;
    const decision = parseConfirmationResponse(responseText, row.tier);
    if (decision === null) return { handled: false };

    if (decision === 'cancelled') {
      await this.db
        .update(pendingConfirmations)
        .set({ status: 'cancelled' })
        .where(eq(pendingConfirmations.id, row.id));
      return { handled: true, message: '❌ Action cancelled.' };
    }

    // Confirmed — execute with reconstructed context
    // currency resolved from store settings in M3
    const context: ToolContext = { userId: row.userId, timezone: row.timezone, currency: 'USD' };
    const result = await execute(row.id, context);
    return { handled: true, result };
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.db
      .update(pendingConfirmations)
      .set({ status: 'expired' })
      .where(
        and(
          eq(pendingConfirmations.status, 'pending'),
          lt(pendingConfirmations.expiresAt, new Date())
        )
      )
      .returning({ id: pendingConfirmations.id });

    return result.length;
  }

  getPromptText(toolName: string, params: unknown, tier: number, context: ToolContext): string {
    return getPromptText(toolName, params, tier, context);
  }
}
