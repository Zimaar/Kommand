import type { FastifyInstance } from 'fastify';
import { AppError } from '../utils/errors.js';
import { MessageIngestionService } from '../channels/ingestion.js';

const KNOWN_CHANNEL_TYPES = new Set(['whatsapp', 'slack', 'email', 'telegram']);

export async function webhookRoutes(app: FastifyInstance) {
  const ingestion = new MessageIngestionService(app.log);

  app.post<{ Params: { channelType: string } }>(
    '/webhook/:channelType',
    async (request, reply) => {
      const { channelType } = request.params;

      if (!KNOWN_CHANNEL_TYPES.has(channelType)) {
        throw AppError.validationError(`Unknown channel type: ${channelType}`);
      }

      // Enqueue for async processing — return 200 immediately
      ingestion.enqueue(channelType, request.body);

      return reply.status(200).send({ received: true });
    }
  );
}
