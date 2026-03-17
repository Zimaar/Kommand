import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { webhookRoutes } from './webhook.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(webhookRoutes);
}
