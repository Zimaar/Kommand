import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolDispatcher, type CommandStore } from '../tool-dispatcher.js';
import { ToolRegistry } from '../tool-registry.js';
import { InMemoryConfirmationEngine } from '../confirmation-engine.js';
import type { ToolContext } from '@kommand/shared';

const ctx: ToolContext = {
  userId: 'user-abc',
  currency: 'AED',
  timezone: 'Asia/Dubai',
};

function makeCommandStore(): CommandStore {
  const commands = new Map<string, { id: string; output: unknown; status: string }>();
  const byKey = new Map<string, string>();

  return {
    findByIdempotencyKey: vi.fn(async (key: string) => {
      const id = byKey.get(key);
      return id ? (commands.get(id) ?? null) : null;
    }),
    create: vi.fn(async (opts) => {
      const id = crypto.randomUUID();
      commands.set(id, { id, output: null, status: opts.status });
      byKey.set(opts.idempotencyKey, id);
      return { id };
    }),
    update: vi.fn(async (id, opts) => {
      const cmd = commands.get(id);
      if (cmd) Object.assign(cmd, opts);
    }),
  };
}

describe('ToolDispatcher', () => {
  let registry: ToolRegistry;
  let confirmEngine: InMemoryConfirmationEngine;
  let store: CommandStore;

  beforeEach(() => {
    registry = new ToolRegistry();
    confirmEngine = new InMemoryConfirmationEngine();
    store = makeCommandStore();
  });

  it('executes a tier-0 tool immediately and returns data', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: { revenue: 9800 } });
    registry.register({
      name: 'get_sales_summary',
      description: 'Get sales',
      inputSchema: { type: 'object', properties: {} },
      confirmationTier: 0,
      platform: 'shopify',
      handler,
    });

    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);
    const result = await dispatcher.dispatch('get_sales_summary', { period: 'today' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { revenue: number }).revenue).toBe(9800);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns requiresConfirmation for tier-1 tool without executing it', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'send_invoice',
      description: 'Send invoice',
      inputSchema: { type: 'object', properties: {} },
      confirmationTier: 1,
      platform: 'xero',
      handler,
    });

    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);
    const result = await dispatcher.dispatch('send_invoice', { invoice_number: 'INV-001' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { requiresConfirmation: boolean }).requiresConfirmation).toBe(true);
    expect((result.data as { confirmationId: string }).confirmationId).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes confirmed tool on executeConfirmed', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: { sent: true } });
    registry.register({
      name: 'send_invoice',
      description: 'Send invoice',
      inputSchema: { type: 'object', properties: {} },
      confirmationTier: 1,
      platform: 'xero',
      handler,
    });

    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);

    // First: request confirmation
    const pending = await dispatcher.dispatch('send_invoice', { invoice_number: 'INV-002' }, ctx);
    const confirmationId = (pending.data as { confirmationId: string }).confirmationId;

    // Then: confirm and execute
    const result = await dispatcher.executeConfirmed(confirmationId, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { sent: boolean }).sent).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns cached result on duplicate call (idempotency)', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: { revenue: 5000 } });
    registry.register({
      name: 'get_sales_summary',
      description: 'Get sales',
      inputSchema: { type: 'object', properties: {} },
      confirmationTier: 0,
      platform: 'shopify',
      handler,
    });

    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);
    const params = { period: 'today' };

    const first = await dispatcher.dispatch('get_sales_summary', params, ctx);
    const second = await dispatcher.dispatch('get_sales_summary', params, ctx);

    // Handler should only run once; second call returns the cached result
    expect(handler).toHaveBeenCalledOnce();
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect((second.data as { revenue: number }).revenue).toBe(5000);
  });

  it('wraps thrown error into friendly ToolResult', async () => {
    registry.register({
      name: 'refund_order',
      description: 'Refund',
      inputSchema: { type: 'object', properties: {} },
      confirmationTier: 0,
      platform: 'shopify',
      handler: vi.fn().mockRejectedValue(new Error('Shopify API 500')),
    });

    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);
    const result = await dispatcher.dispatch('refund_order', { order_id: '123' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('Shopify API 500'); // raw error hidden
    expect(result.error).toContain('refund_order');
  });

  it('returns error for unknown tool', async () => {
    const dispatcher = new ToolDispatcher(registry, confirmEngine, store);
    const result = await dispatcher.dispatch('nonexistent', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });
});
