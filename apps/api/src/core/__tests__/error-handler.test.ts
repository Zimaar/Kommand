import { describe, it, expect } from 'vitest';
import { handlePipelineError } from '../error-handler.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

const USER = 'u1';
const CHANNEL = 'whatsapp';

describe('handlePipelineError', () => {
  it('returns an OutboundMessage with userId and channelType', () => {
    const msg = handlePipelineError(new Error('boom'), USER, CHANNEL);
    expect(msg.userId).toBe(USER);
    expect(msg.channelType).toBe(CHANNEL);
    expect(typeof msg.text).toBe('string');
  });

  it('returns rate-limit message for RATE_LIMIT_EXCEEDED', () => {
    const err = AppError.rateLimitExceeded();
    const msg = handlePipelineError(err, USER, CHANNEL);
    expect(msg.text).toContain("You've sent a lot of messages");
  });

  it('returns platform-specific message for EXTERNAL_API_ERROR', () => {
    const err = AppError.externalApiError('Shopify 503');
    const msg = handlePipelineError(err, USER, CHANNEL, { platform: 'Shopify' });
    expect(msg.text).toContain('Shopify');
    expect(msg.text).toContain('temporary');
  });

  it('uses generic platform name when none given', () => {
    const err = AppError.externalApiError('timeout');
    const msg = handlePipelineError(err, USER, CHANNEL);
    expect(msg.text).toContain('the service');
  });

  it('returns action-specific message for TOOL_EXECUTION_ERROR', () => {
    const err = AppError.toolExecutionError('refund failed');
    const msg = handlePipelineError(err, USER, CHANNEL, { action: 'process the refund' });
    expect(msg.text).toContain('process the refund');
    expect(msg.text).toContain('try again');
  });

  it('sanitizes raw URLs from error messages', () => {
    const err = AppError.toolExecutionError('https://secret-api.com/token?key=abc123');
    const msg = handlePipelineError(err, USER, CHANNEL);
    expect(msg.text).not.toContain('https://');
    expect(msg.text).toContain('[url]');
  });

  it('returns generic message for unknown errors', () => {
    const msg = handlePipelineError(new Error('something weird'), USER, CHANNEL);
    expect(msg.text).toContain("unexpected");
  });

  it('handles non-Error objects gracefully', () => {
    const msg = handlePipelineError({ code: 42 }, USER, CHANNEL);
    expect(msg.text).toContain("unexpected");
  });

  it('returns Claude-down message for Anthropic errors', () => {
    const err = new Error('anthropic API overloaded');
    const msg = handlePipelineError(err, USER, CHANNEL);
    expect(msg.text).toContain('brain freeze');
  });

  it('returns DB-down message for database connection errors', () => {
    const err = new Error('ECONNREFUSED: database connection failed');
    const msg = handlePipelineError(err, USER, CHANNEL);
    expect(msg.text).toContain("memory");
  });
});

describe('circuit breaker integration', () => {
  it('getOpenMessage returns platform name', async () => {
    const { circuitBreaker } = await import('../circuit-breaker.js');
    expect(circuitBreaker.getOpenMessage('shopify')).toContain('Shopify');
    expect(circuitBreaker.getOpenMessage('xero')).toContain('Xero');
  });

  it('opens after 5 failures and blocks further calls', async () => {
    const { CircuitBreaker } = await import('../circuit-breaker.js');
    const cb = new CircuitBreaker();

    expect(cb.isOpen('shopify')).toBe(false);
    for (let i = 0; i < 5; i++) cb.recordFailure('shopify');
    expect(cb.isOpen('shopify')).toBe(true);
  });

  it('closes on success after being open', async () => {
    const { CircuitBreaker } = await import('../circuit-breaker.js');
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure('xero');
    expect(cb.isOpen('xero')).toBe(true);
    cb.recordSuccess('xero');
    expect(cb.isOpen('xero')).toBe(false);
  });
});

describe('retry utility', () => {
  it('retries on transient errors and resolves', async () => {
    const { withRetry } = await import('../retry.js');
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('timeout');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry on non-transient errors', async () => {
    const { withRetry } = await import('../retry.js');
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('invalid input');
      })
    ).rejects.toThrow('invalid input');
    expect(calls).toBe(1); // no retry
  });

  it('throws after exhausting retries', async () => {
    const { withRetry } = await import('../retry.js');
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('socket hang up');
      }, { maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow('socket hang up');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});
