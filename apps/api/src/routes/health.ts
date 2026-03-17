import type { FastifyInstance } from 'fastify';

const startTime = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return {
      status: 'ok',
      version: process.env['npm_package_version'] ?? '1.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  });
}
