import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryConfirmationEngine } from '../confirmation-engine.js';
import type { ToolContext, ToolResult } from '@kommand/shared';

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
