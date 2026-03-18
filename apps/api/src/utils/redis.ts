import { Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    const url = process.env['REDIS_URL'];
    if (!url) throw new Error('REDIS_URL environment variable is not set');

    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.error('[Redis] connection error:', err);
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
