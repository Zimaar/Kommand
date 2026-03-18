import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import type { MessageIngestionService } from '../../ingestion.js';

// ─── Meta payload schemas ─────────────────────────────────────────────────────

const MetaMessage = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ payload: z.string() }).optional(),
        list_reply: z.object({ id: z.string() }).optional(),
      })
      .optional(),
  })
  .passthrough();

const MetaStatus = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string(),
  })
  .passthrough();

const MetaPayload = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              messages: z.array(MetaMessage).optional(),
              statuses: z.array(MetaStatus).optional(),
            })
            .passthrough(),
        })
      ),
    })
  ),
});

type ParsedMetaMessage = z.infer<typeof MetaMessage>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(msg: ParsedMetaMessage): string | null {
  if (msg.type === 'text') return msg.text?.body ?? null;
  if (msg.type === 'interactive') {
    if (msg.interactive?.type === 'button_reply') return msg.interactive.button_reply?.payload ?? null;
    if (msg.interactive?.type === 'list_reply') return msg.interactive.list_reply?.id ?? null;
  }
  return null; // image, location, reaction, sticker, etc. — ignored for now
}

function verifySignature(secret: string, rawBody: Buffer, header: string): boolean {
  const hmac = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (hmac.length !== header.length) return false;
  return timingSafeEqual(Buffer.from(hmac), Buffer.from(header));
}

// ─── Route factory ────────────────────────────────────────────────────────────

// WeakMap stores raw body per request without polluting FastifyRequest types
const rawBodyStore = new WeakMap<object, Buffer>();

export function whatsappInboundRoutes(ingestion: MessageIngestionService) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // Override JSON parser (scoped to this plugin) to capture raw bytes for HMAC
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      const buf = body as Buffer;
      rawBodyStore.set(_req, buf);
      try {
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    app.post('/webhook/whatsapp', async (request, reply) => {
      // 1. Signature verification
      const rawBody = rawBodyStore.get(request) ?? Buffer.alloc(0);
      const sigHeader = request.headers['x-hub-signature-256'];

      if (config.WHATSAPP_APP_SECRET) {
        if (!sigHeader || typeof sigHeader !== 'string') {
          request.log.warn('WhatsApp webhook missing X-Hub-Signature-256 header');
          return reply.status(403).send();
        }
        if (!verifySignature(config.WHATSAPP_APP_SECRET, rawBody, sigHeader)) {
          request.log.warn('WhatsApp webhook signature mismatch');
          return reply.status(403).send();
        }
      } else {
        request.log.warn('WHATSAPP_APP_SECRET not configured — skipping signature verification (dev only)');
      }

      // 2. Parse and validate Meta payload shape
      const result = MetaPayload.safeParse(request.body);
      if (!result.success) {
        request.log.warn({ errors: result.error.errors }, 'Invalid WhatsApp webhook payload');
        return reply.status(200).send(); // always 200 — Meta will retry on error
      }

      // 3. Walk entry → changes → value
      for (const entry of result.data.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'messages') continue;

          const { messages = [], statuses = [] } = change.value;

          // 4a. Process inbound messages (text + interactive only)
          for (const msg of messages) {
            const text = extractText(msg);
            if (text === null) {
              request.log.debug({ type: msg.type, id: msg.id }, 'Skipping unsupported message type');
              continue;
            }

            request.log.info({ from: msg.from, id: msg.id, type: msg.type }, 'Queueing WhatsApp message');
            ingestion.enqueue('whatsapp', {
              from: msg.from,
              id: msg.id,
              text,
              timestamp: msg.timestamp,
            });
          }

          // 4b. Log delivery status updates
          // TODO: persist delivery status in DB when messages table gains a status column (M4+)
          for (const status of statuses) {
            request.log.info(
              { messageId: status.id, status: status.status, recipient: status.recipient_id },
              'WhatsApp delivery status'
            );
          }
        }
      }

      // Always return 200 immediately — Meta retries on any non-200
      return reply.status(200).send();
    });
  };
}
