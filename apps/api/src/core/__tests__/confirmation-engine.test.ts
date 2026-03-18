import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryConfirmationEngine, DbConfirmationEngine } from '../confirmation-engine.js';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';

const ctx: ToolContext = { userId: 'u1', currency: 'AED', timezone: 'Asia/Dubai' };

const baseOpts = {
  userId: 'u1',
  commandId: 'cmd-1',
  toolName: 'send_invoice',
  params: { invoice_number: 'INV-001' },
  context: ctx,
  promptText: 'Send invoice INV-001? (Yes/No)',
  tier: 1,
};

describe('InMemoryConfirmationEngine', () => {
  let engine: InMemoryConfirmationEngine;

  beforeEach(() => {
    engine = new InMemoryConfirmationEngine();
  });

  it('creates a confirmation and retrieves it', async () => {
    const record = await engine.create(baseOpts);
    expect(record.id).toBeTruthy();
    expect(record.toolName).toBe('send_invoice');
    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const fetched = await engine.get(record.id);
    expect(fetched?.id).toBe(record.id);
  });

  it('handleResponse("yes") executes the tool and returns result', async () => {
    await engine.create(baseOpts);
    const mockResult: ToolResult = { success: true, data: { sent: true } };
    const execute = vi.fn().mockResolvedValue(mockResult);

    const response = await engine.handleResponse('u1', 'yes', execute);

    expect(response.handled).toBe(true);
    expect(response.result).toEqual(mockResult);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('handleResponse("y") also confirms', async () => {
    await engine.create(baseOpts);
    const execute = vi.fn().mockResolvedValue({ success: true });
    const response = await engine.handleResponse('u1', 'y', execute);
    expect(response.handled).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('handleResponse("no") cancels without executing', async () => {
    await engine.create(baseOpts);
    const execute = vi.fn();
    const response = await engine.handleResponse('u1', 'no', execute);

    expect(response.handled).toBe(true);
    expect(response.message).toContain('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('handleResponse("cancel") also cancels', async () => {
    await engine.create(baseOpts);
    const execute = vi.fn();
    const response = await engine.handleResponse('u1', 'cancel', execute);
    expect(response.handled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('handleResponse with unrecognized text returns { handled: false }', async () => {
    await engine.create(baseOpts);
    const execute = vi.fn();
    const response = await engine.handleResponse('u1', 'maybe later', execute);
    expect(response.handled).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('handleResponse returns { handled: false } when no pending confirmation', async () => {
    const execute = vi.fn();
    const response = await engine.handleResponse('u1', 'yes', execute);
    expect(response.handled).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('tier-3 requires exact "CONFIRM" (case-insensitive)', async () => {
    await engine.create({ ...baseOpts, tier: 3, toolName: 'bulk_update_prices' });
    const execute = vi.fn().mockResolvedValue({ success: true });

    // "yes" should not confirm tier-3
    const noMatch = await engine.handleResponse('u1', 'yes', execute);
    expect(noMatch.handled).toBe(false);

    // "CONFIRM" should confirm
    await engine.create({ ...baseOpts, commandId: 'cmd-2', tier: 3 });
    const match = await engine.handleResponse('u1', 'CONFIRM', execute);
    expect(match.handled).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('cleanupExpired removes expired confirmations and returns count', async () => {
    // Create a confirmation that is already expired
    const expired = await engine.create(baseOpts);
    // Manually backdate the expiresAt
    (expired as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    // Poke the internal store directly via get() — it checks expiry
    const fetched = await engine.get(expired.id);
    expect(fetched).toBeNull(); // auto-expired on get

    // Create a fresh confirmation
    const fresh = await engine.create({ ...baseOpts, commandId: 'cmd-fresh' });
    expect(await engine.get(fresh.id)).not.toBeNull();

    const count = await engine.cleanupExpired();
    // 0 because the expired one was already removed by get()
    expect(count).toBe(0);
  });

  it('cleanupExpired via direct expiry manipulation', async () => {
    // Create two confirmations
    const r1 = await engine.create({ ...baseOpts, commandId: 'a' });
    const r2 = await engine.create({ ...baseOpts, commandId: 'b' });

    // Backdate both via the record (in-memory store exposes the object)
    r1.expiresAt = new Date(Date.now() - 5000);
    r2.expiresAt = new Date(Date.now() - 5000);

    const count = await engine.cleanupExpired();
    expect(count).toBe(2);
  });

  it('getPromptText generates tier-1 message', () => {
    const text = engine.getPromptText('send_invoice', { invoice_number: 'INV-099' }, 1, ctx);
    expect(text).toContain('INV-099');
    expect(text).toContain('Yes/No');
  });

  it('getPromptText generates tier-2 refund message', () => {
    const text = engine.getPromptText(
      'refund_order',
      { order_identifier: '#1847', amount: 145, reason: 'Customer request' },
      2,
      ctx
    );
    expect(text).toContain('#1847');
    expect(text).toContain('145');
  });

  it('getPromptText generates tier-3 CONFIRM warning', () => {
    const text = engine.getPromptText('bulk_update_prices', { percent: 20 }, 3, ctx);
    expect(text).toContain('⚠️');
    expect(text).toContain('CONFIRM');
  });
});

// ─── DbConfirmationEngine ─────────────────────────────────────────────────────

function makeDbChain(result: unknown[]) {
  // Drizzle's select().from().innerJoin()...where().orderBy().limit() returns a thenable
  const chain: Record<string, unknown> = {};
  const end = { then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res) };
  chain['select'] = vi.fn().mockReturnValue(chain);
  chain['from'] = vi.fn().mockReturnValue(chain);
  chain['innerJoin'] = vi.fn().mockReturnValue(chain);
  chain['where'] = vi.fn().mockReturnValue(chain);
  chain['orderBy'] = vi.fn().mockReturnValue(chain);
  chain['limit'] = vi.fn().mockReturnValue(end);
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain['update'] = vi.fn().mockReturnValue(chain);
  chain['set'] = vi.fn().mockReturnValue(chain);
  chain['where'] = vi.fn().mockReturnValue(Promise.resolve());
  return chain;
}

describe('DbConfirmationEngine.get', () => {
  it('returns null when row is not found', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const chain = makeDbChain([]);
    vi.mocked(db.select).mockReturnValue(chain as ReturnType<DB['select']>);

    const engine = new DbConfirmationEngine(db);
    expect(await engine.get('some-id')).toBeNull();
  });

  it('returns null when status is not pending', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const chain = makeDbChain([{
      id: 'c1', userId: 'u1', commandId: 'cmd1',
      promptText: 'Confirm?', expiresAt: new Date(Date.now() + 60000),
      status: 'confirmed', toolName: 'fulfill_order',
      params: {}, tier: 1, timezone: 'UTC',
    }]);
    vi.mocked(db.select).mockReturnValue(chain as ReturnType<DB['select']>);

    const engine = new DbConfirmationEngine(db);
    expect(await engine.get('c1')).toBeNull();
  });

  it('returns null when expired', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const chain = makeDbChain([{
      id: 'c1', userId: 'u1', commandId: 'cmd1',
      promptText: 'Confirm?', expiresAt: new Date(Date.now() - 1000),
      status: 'pending', toolName: 'fulfill_order',
      params: {}, tier: 1, timezone: 'UTC',
    }]);
    vi.mocked(db.select).mockReturnValue(chain as ReturnType<DB['select']>);

    const engine = new DbConfirmationEngine(db);
    expect(await engine.get('c1')).toBeNull();
  });

  it('returns full PendingConfirmationRecord for a valid pending row', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    const db = { select: vi.fn() } as unknown as DB;
    const chain = makeDbChain([{
      id: 'c1', userId: 'u1', commandId: 'cmd1',
      promptText: 'Confirm?', expiresAt,
      status: 'pending', toolName: 'refund_order',
      params: { order_identifier: '#1234' }, tier: 2, timezone: 'America/New_York',
    }]);
    vi.mocked(db.select).mockReturnValue(chain as ReturnType<DB['select']>);

    const engine = new DbConfirmationEngine(db);
    const record = await engine.get('c1');

    expect(record).not.toBeNull();
    expect(record!.toolName).toBe('refund_order');
    expect(record!.tier).toBe(2);
    expect(record!.params).toEqual({ order_identifier: '#1234' });
    expect(record!.context.timezone).toBe('America/New_York');
    expect(record!.context.userId).toBe('u1');
  });
});

describe('DbConfirmationEngine.handleResponse', () => {
  it('returns { handled: false } when no pending confirmation', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const chain = makeDbChain([]);
    vi.mocked(db.select).mockReturnValue(chain as ReturnType<DB['select']>);

    const engine = new DbConfirmationEngine(db);
    const result = await engine.handleResponse('u1', 'yes', vi.fn());
    expect(result.handled).toBe(false);
  });

  it('cancels on "no" and does not execute', async () => {
    const db = { select: vi.fn(), update: vi.fn() } as unknown as DB;
    const selectChain = makeDbChain([{ id: 'c1', userId: 'u1', tier: 1, timezone: 'UTC' }]);
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<DB['select']>);
    const updateChain = makeUpdateChain();
    vi.mocked(db.update).mockReturnValue(updateChain as ReturnType<DB['update']>);

    const execute = vi.fn();
    const engine = new DbConfirmationEngine(db);
    const result = await engine.handleResponse('u1', 'no', execute);

    expect(result.handled).toBe(true);
    expect(result.message).toContain('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes on "yes" with reconstructed context including tier', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const selectChain = makeDbChain([{ id: 'c1', userId: 'u1', tier: 2, timezone: 'Asia/Dubai' }]);
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<DB['select']>);

    const execute = vi.fn().mockResolvedValue({ success: true });
    const engine = new DbConfirmationEngine(db);
    const result = await engine.handleResponse('u1', 'yes', execute);

    expect(result.handled).toBe(true);
    expect(execute).toHaveBeenCalledWith('c1', expect.objectContaining({ userId: 'u1', timezone: 'Asia/Dubai' }));
  });

  it('returns { handled: false } for unrecognized text', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const selectChain = makeDbChain([{ id: 'c1', userId: 'u1', tier: 1, timezone: 'UTC' }]);
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<DB['select']>);

    const execute = vi.fn();
    const engine = new DbConfirmationEngine(db);
    const result = await engine.handleResponse('u1', 'maybe', execute);

    expect(result.handled).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires CONFIRM for tier-3, rejects "yes"', async () => {
    const db = { select: vi.fn() } as unknown as DB;
    const selectChain = makeDbChain([{ id: 'c1', userId: 'u1', tier: 3, timezone: 'UTC' }]);
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<DB['select']>);

    const execute = vi.fn();
    const engine = new DbConfirmationEngine(db);
    const result = await engine.handleResponse('u1', 'yes', execute);

    expect(result.handled).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
