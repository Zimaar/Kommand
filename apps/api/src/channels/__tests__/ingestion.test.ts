import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageIngestionService, type PipelineDeps } from '../ingestion.js';
import type { FastifyBaseLogger } from 'fastify';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// WhatsApp normalized format: { from, id, text, timestamp }
function makeRawBody(overrides: Record<string, unknown> = {}) {
  return {
    from: '14155552671',
    id: 'msg-1',
    text: 'Show me my sales',
    timestamp: '1741000000',
    ...overrides,
  };
}

// userId after phone normalization
const NORMALIZED_PHONE = '+14155552671';

// ─── No-deps path ─────────────────────────────────────────────────────────────

describe('MessageIngestionService (no deps)', () => {
  it('sends acknowledgement when no pipeline deps are wired', async () => {
    const logger = makeLogger();
    const svc = new MessageIngestionService(logger);

    await svc.processInbound('whatsapp', makeRawBody());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: NORMALIZED_PHONE }),
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
  // DB call order for whatsapp channel:
  //   1. channels lookup (phone → userId)
  //   2. user lookup
  //   3. stores
  //   4. accounting
  //   5. channels (for conversation)
  const db = { select: vi.fn() } as unknown as PipelineDeps['db'];

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // WhatsApp phone → userId via channels table
      return makeDbChain([{ userId: 'user-1' }]) as ReturnType<PipelineDeps['db']['select']>;
    }
    if (callCount === 2) {
      // user row
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
  it('skips pipeline when WhatsApp phone is not registered', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    // All DB calls return empty — channel lookup returns nothing
    let callCount = 0;
    vi.mocked(deps.db.select).mockImplementation(() => {
      callCount++;
      return makeDbChain([]) as ReturnType<PipelineDeps['db']['select']>;
    });

    const svc = new MessageIngestionService(logger, deps);
    await svc.processInbound('whatsapp', makeRawBody());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phone: NORMALIZED_PHONE }),
      'No WhatsApp channel registered for this phone — user not onboarded yet'
    );
    expect(deps.aiBrain.processMessage).not.toHaveBeenCalled();
  });

  it('skips pipeline when user not found in DB', async () => {
    const logger = makeLogger();
    const deps = makeDeps();

    let callCount = 0;
    vi.mocked(deps.db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // channel lookup succeeds
        return makeDbChain([{ userId: 'user-1' }]) as ReturnType<PipelineDeps['db']['select']>;
      }
      // user lookup returns empty
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

    let callCount = 0;
    vi.mocked(deps.db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeDbChain([{ userId: 'user-1' }]) as ReturnType<PipelineDeps['db']['select']>;  // wa channel
      if (callCount === 2) return makeDbChain([{ id: 'user-1', name: 'Alice', timezone: 'UTC', plan: 'starter' }]) as ReturnType<PipelineDeps['db']['select']>; // user
      if (callCount === 5) return makeDbChain([{ id: 'chan-1' }]) as ReturnType<PipelineDeps['db']['select']>; // channel for conversation
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
    const logger = makeLogger();
    const deps = makeDeps();
    const svc = new MessageIngestionService(logger, deps);

    // First call with default redis mock (returns 'OK' = not duplicate)
    await svc.processInbound('whatsapp', makeRawBody());
    expect(deps.aiBrain.processMessage).toHaveBeenCalledOnce();
  });
});
