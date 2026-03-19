import { getRedisClient } from './redis.js';
import { AppError } from './errors.js';

const WINDOW_SECONDS = 60;
const MAX_REQUESTS   = 60;

/**
 * Fixed-window rate limiter scoped per user.
 * Uses Redis INCR + EXPIRE: max MAX_REQUESTS per WINDOW_SECONDS.
 *
 * @param userId  - Clerk user ID (or any stable identifier)
 * @param route   - Optional label to namespace separate limits per route group
 * @throws AppError (429) when limit is exceeded
 */
export async function checkRateLimit(userId: string, route = 'api'): Promise<void> {
  const redis = getRedisClient();
  const key   = `rate:${route}:${userId}`;

  const count = await redis.incr(key);

  if (count === 1) {
    // First request in this window — set the TTL
    await redis.expire(key, WINDOW_SECONDS);
  }

  if (count > MAX_REQUESTS) {
    throw AppError.rateLimitExceeded(
      `Rate limit exceeded: max ${MAX_REQUESTS} requests per minute. Try again shortly.`
    );
  }
}
