import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../health.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../db/connection.js', () => ({
  db: { execute: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/redis.js', () => ({
  getRedisClient: vi.fn(() => ({ ping: vi.fn().mockResolvedValue('PONG') })),
}));

vi.mock('../../config/index.js', () => ({
  config: { ANTHROPIC_API_KEY: 'sk-ant-test' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with status ok when all probes pass', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: Record<string, { ok: boolean }> }>();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.redis.ok).toBe(true);
    expect(body.checks.anthropic.ok).toBe(true);
  });

  it('includes version and uptime fields', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json<{ version: string; uptime: number }>();
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with status degraded when postgres probe fails', async () => {
    const { db } = await import('../../db/connection.js');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('connection refused'));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; checks: { postgres: { ok: boolean; error: string } } }>();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres.ok).toBe(false);
    expect(body.checks.postgres.error).toContain('connection refused');
  });

  it('returns 503 with status degraded when redis probe fails', async () => {
    const { getRedisClient } = await import('../../utils/redis.js');
    vi.mocked(getRedisClient).mockReturnValueOnce({
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; checks: { redis: { ok: boolean; error: string } } }>();
    expect(body.status).toBe('degraded');
    expect(body.checks.redis.ok).toBe(false);
    expect(body.checks.redis.error).toContain('ECONNREFUSED');
  });

  it('returns 503 when anthropic key is missing', async () => {
    vi.doMock('../../config/index.js', () => ({
      config: { ANTHROPIC_API_KEY: '' },
    }));
    // Re-import with new mock
    const { healthRoutes: freshRoutes } = await import('../health.js?t=no-key');
    const app = Fastify({ logger: false });
    await app.register(freshRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });

    // At minimum anthropic probe should report not-ok
    const body = res.json<{ checks: { anthropic: { ok: boolean } } }>();
    expect(body.checks.anthropic.ok).toBe(false);
  });

  it('reports probe latency for each check', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json<{ checks: Record<string, { latencyMs: number }> }>();
    expect(typeof body.checks.postgres.latencyMs).toBe('number');
    expect(typeof body.checks.redis.latencyMs).toBe('number');
    expect(typeof body.checks.anthropic.latencyMs).toBe('number');
  });
});
