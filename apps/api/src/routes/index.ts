import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { webhookRoutes, buildPipelineDeps } from './webhook.js';
import { shopifyAuthRoutes } from './shopify-auth.js';
import { connectionRoutes } from './connections.js';
import { whatsappChannelRoutes } from './whatsapp-channels.js';
import { userPreferencesRoutes } from './user-preferences.js';
import { whatsappWebhookRoutes } from '../channels/adapters/whatsapp/webhook.js';
import { whatsappInboundRoutes } from '../channels/adapters/whatsapp/inbound.js';
import { MessageIngestionService } from '../channels/ingestion.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(shopifyAuthRoutes);
  await app.register(connectionRoutes);
  await app.register(whatsappChannelRoutes);
  await app.register(userPreferencesRoutes);

  // Shared pipeline — single ingestion service used by both the generic and WhatsApp-specific handlers
  const deps = buildPipelineDeps();
  const ingestion = new MessageIngestionService(app.log, deps);

  // GET /webhook/whatsapp — Meta verification (must be registered before POST)
  await app.register(whatsappWebhookRoutes);

  // POST /webhook/whatsapp — WhatsApp inbound (signature-verified, Meta payload aware)
  await app.register(whatsappInboundRoutes(ingestion));

  // POST /webhook/:channelType — generic fallback for other channels
  await app.register((f) => webhookRoutes(f, ingestion));
}
