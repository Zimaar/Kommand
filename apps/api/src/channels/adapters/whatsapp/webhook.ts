import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';

interface WhatsAppVerifyQuery {
  'hub.mode': string;
  'hub.verify_token': string;
  'hub.challenge': string;
}

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  // Meta webhook verification — must return hub.challenge as plain text
  app.get<{ Querystring: WhatsAppVerifyQuery }>(
    '/webhook/whatsapp',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            'hub.mode': { type: 'string' },
            'hub.verify_token': { type: 'string' },
            'hub.challenge': { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const mode = request.query['hub.mode'];
      const token = request.query['hub.verify_token'];
      const challenge = request.query['hub.challenge'];

      if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
        return reply.status(200).type('text/plain').send(challenge);
      }

      return reply.status(403).send();
    }
  );
}
