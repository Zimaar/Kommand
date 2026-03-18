import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { webhookRoutes } from './webhook.js';
import { shopifyAuthRoutes } from './shopify-auth.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(shopifyAuthRoutes);
}
