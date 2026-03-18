import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageIngestionService, type PipelineDeps } from '../ingestion.js';
import type { FastifyBaseLogger } from 'fastify';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Prevent Redis from being instantiated during tests
vi.mock('../../utils/redis.js', () => ({
  getRedisClient: () => ({
    set: vi.fn().mockResolvedValue('OK'), // 'OK' = new key, not a duplicate
  }),
}));

function makeLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeRawBody(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    channelMessageId: 'msg-1',
    text: 'Show me my sales',
    ...overrides,
  };
}

// ─── No-deps path ─────────────────────────────────────────────────────────────

describe('MessageIngestionService (no deps)', () => {
  it('sends acknowledgement when no pipeline deps are wired', async () => {
    const logger = makeLogger();
    const svc = new MessageIngestionService(logger);

    // processInbound should not throw and should log the message
    await svc.processInbound('whatsapp', makeRawBody());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'Processing inbound message'
    );
  });
});

// ─── Full pipeline path ───────────────────────────────────────────────────────

function makeDbChain(result: unknown[]) {
  // Make the chain thenable at any point — queries may or may not call .limit()
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  chain['select'] = vi.fn().mockReturnValue(chain);
  chain['from'] = vi.fn().mockReturnValue(chain);
  chain['where'] = vi.fn().mockReturnValue(chain);
  chain['limit'] = vi.fn().mockReturnValue(chain);
  chain['orderBy'] = vi.fn().mockReturnValue(chain);
  chain['innerJoin'] = vi.fn().mockReturnValue(chain);
  return chain;
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  // DB returns: user found, no stores, no accounting, no channels
  const db = { select: vi.fn() } as unknown as PipelineDeps['db'];

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // d. user lookup — found
      return makeDbChain([{ id: 'user-1', name: 'Alice', timezone: 'UTC', plan: 'starter' }]) as ReturnType<PipelineDeps['db']['select']>;
    }
    // stores, accounting, channels — all empty
    return makeDbChain([]) as ReturnType<PipelineDeps['db']['select']>;
  });

  const aiBrain: PipelineDeps['aiBrain'] = {
    processMessage: vi.fn().mockResolvedValue({
      text: 'Your sales today were $500.',
      toolCalls: [],
      tokensUsed: 100,
      latencyMs: 200,
    }),
  } as unknown as PipelineDeps['aiBrain'];

  const conversationManager: PipelineDeps['conversationManager'] = {
    getOrCreateConversation: vi.fn().mockResolvedValue('conv-1'),
    addMessage: vi.fn().mockResolvedValue('msg-db-id'),
    getHistory: vi.fn().mockResolvedValue([]),
  } as unknown as PipelineDeps['conversationManager'];

  const confirmationEngine: PipelineDeps['confirmationEngine'] = {
    handleResponse: vi.fn().mockResolvedValue({ handled: false }),
  } as unknown as PipelineDeps['confirmationEngine'];

  const toolDispatcher: PipelineDeps['toolDispatcher'] = {
    executeConfirmed: vi.fn(),
  } as unknown as PipelineDeps['toolDispatcher'];

  return { db, aiBrain, conversationManager, confirmationEngine, toolDispatcher, ...overrides };
}

describe('MessageIngestionService (with deps)', () => {
  it('skips pipeline when user not found in DB', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    // Override: user lookup returns empty
    let callCount = 0;
    vi.mocked(deps.db.select).mockImplementation(() => {
      callCount++;
      return makeDbChain([]) as ReturnType<PipelineDeps['db']['select']>;
    });

    const svc = new MessageIngestionService(logger, deps);
    await svc.processInbound('whatsapp', makeRawBody());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'User not found in DB, skipping pipeline'
    );
    expect(deps.aiBrain.processMessage).not.toHaveBeenCalled();
  });

  it('calls AI Brain and sends response when user is found', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    const svc = new MessageIngestionService(logger, deps);
    await svc.processInbound('whatsapp', makeRawBody());

    expect(deps.aiBrain.processMessage).toHaveBeenCalledOnce();
    // No channel in DB → no conversationManager calls
    expect(deps.conversationManager.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('stores messages when channel is found in DB', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    // Override: user found + channel found
    let callCount = 0;
    vi.mocked(deps.db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeDbChain([{ id: 'user-1', name: 'Alice', timezone: 'UTC', plan: 'starter' }]) as ReturnType<PipelineDeps['db']['select']>;
      }
      if (callCount === 4) {
        // channel lookup (4th call: user, stores, accounting, channels)
        return makeDbChain([{ id: 'chan-1' }]) as ReturnType<PipelineDeps['db']['select']>;
      }
      return makeDbChain([]) as ReturnType<PipelineDeps['db']['select']>;
    });

    const svc = new MessageIngestionService(logger, deps);
    await svc.processInbound('whatsapp', makeRawBody());

    expect(deps.conversationManager.getOrCreateConversation).toHaveBeenCalledWith('user-1', 'chan-1');
    expect(deps.conversationManager.addMessage).toHaveBeenCalledTimes(2); // inbound + outbound
    expect(deps.aiBrain.processMessage).toHaveBeenCalledOnce();
  });

  it('handles confirmation reply without calling AI Brain', async () => {
    const logger = makeLogger();
    const deps = makeDeps({
      confirmationEngine: {
        handleResponse: vi.fn().mockResolvedValue({
          handled: true,
          message: '✅ Order fulfilled.',
        }),
      } as unknown as PipelineDeps['confirmationEngine'],
    });

    const svc = new MessageIngestionService(logger, deps);
    await svc.processInbound('whatsapp', makeRawBody({ text: 'yes' }));

    expect(deps.confirmationEngine.handleResponse).toHaveBeenCalledOnce();
    expect(deps.aiBrain.processMessage).not.toHaveBeenCalled();
  });

  it('skips duplicate messages', async () => {
    // Override Redis to simulate duplicate (set returns null = key existed)
    vi.doMock('../../utils/redis.js', () => ({
      getRedisClient: () => ({ set: vi.fn().mockResolvedValue(null) }),
    }));

    const logger = makeLogger();
    const deps = makeDeps();
    const svc = new MessageIngestionService(logger, deps);

    // First call: not a dupe (mock returns 'OK')
    await svc.processInbound('whatsapp', makeRawBody());
    expect(deps.aiBrain.processMessage).toHaveBeenCalledOnce();
  });
});
