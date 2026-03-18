import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { getRedisClient } from '../utils/redis.js';
import { config } from '../config/index.js';

const startTime = Date.now();
const PROBE_TIMEOUT_MS = 3_000;

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function probeWithTimeout(fn: () => Promise<void>, label: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const [postgres, redis, anthropic] = await Promise.all([
      probeWithTimeout(async () => {
        await db.execute(sql`SELECT 1`);
      }, 'postgres'),

      probeWithTimeout(async () => {
        const pong = await getRedisClient().ping();
        if (pong !== 'PONG') throw new Error(`unexpected Redis response: ${pong}`);
      }, 'redis'),

      // Anthropic: verify the key is configured — no API call to avoid cost/latency
      probeWithTimeout(async () => {
        if (!config.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
      }, 'anthropic'),
    ]);

    const allOk = postgres.ok && redis.ok && anthropic.ok;

    void reply.status(allOk ? 200 : 503);
    return {
      status: allOk ? 'ok' : 'degraded',
      version: process.env['npm_package_version'] ?? '1.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: { postgres, redis, anthropic },
    };
  });
}
