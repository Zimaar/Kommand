import { AppError } from '../../../utils/errors.js';
import { getRedisClient } from '../../../utils/redis.js';
import { WHATSAPP_API_VERSION } from '../../../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WhatsAppSendResult {
  messageId: string;
  status: string;
}

interface ButtonRow {
  id: string;
  title: string;
}

interface ListRow {
  id: string;
  title: string;
  description?: string;
}

interface ListSection {
  title: string;
  rows: ListRow[];
}

/** A single component inside a WhatsApp template (body, header, button, etc.) */
export interface WhatsAppTemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: number;
  parameters: Array<
    | { type: 'text'; text: string }
    | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
    | { type: 'image'; image: { link: string } }
  >;
}

// Meta Graph API error shape
interface MetaErrorResponse {
  error?: {
    code?: number;
    message?: string;
    error_subcode?: number;
    error_data?: unknown;
  };
}

// ─── Known Meta error codes ───────────────────────────────────────────────────

const META_ERROR_MESSAGES: Record<number, string> = {
  131026: 'Invalid phone number — recipient is not a valid WhatsApp account',
  131047: 'Message failed to send due to an unknown error',
  131048: 'Spam rate limit hit — too many messages to this recipient',
  131049: 'Template message not approved or not found',
  130429: 'Cloud API rate limit reached — slow down',
  131000: 'Generic message send failure',
  131051: 'Unsupported message type',
};

// ─── Rate limiter (token bucket via Redis) ────────────────────────────────────

const RATE_LIMIT_KEY = 'whatsapp:rate:tokens';
const RATE_LIMIT_CAPACITY = 250;     // max burst
const RATE_LIMIT_REFILL_RATE = 250;  // tokens per second
const RATE_LIMIT_REFILL_INTERVAL = 1; // seconds

async function acquireToken(): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const now = Math.floor(Date.now() / 1000);
    const lastRefillKey = 'whatsapp:rate:last_refill';

    // Lua script: atomic token bucket check+consume
    const lua = `
      local tokens_key = KEYS[1]
      local last_refill_key = KEYS[2]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])

      local tokens = tonumber(redis.call('GET', tokens_key) or capacity)
      local last_refill = tonumber(redis.call('GET', last_refill_key) or now)

      -- Refill tokens based on elapsed time
      local elapsed = now - last_refill
      local refilled = math.min(capacity, tokens + elapsed * refill_rate)

      if refilled < 1 then
        return 0
      end

      redis.call('SET', tokens_key, refilled - 1, 'EX', 60)
      redis.call('SET', last_refill_key, now, 'EX', 60)
      return 1
    `;

    const result = await redis.eval(
      lua,
      2,
      RATE_LIMIT_KEY,
      lastRefillKey,
      RATE_LIMIT_CAPACITY,
      RATE_LIMIT_REFILL_RATE,
      now
    );
    return result === 1;
  } catch {
    // Redis unavailable — allow the send (fail open)
    return true;
  }
}

// ─── WhatsAppSender ───────────────────────────────────────────────────────────

export class WhatsAppSender {
  private readonly baseUrl: string;

  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string
  ) {
    this.baseUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}`;
  }

  // ─── Public send methods ────────────────────────────────────────────────────

  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };
    return this.post(body);
  }

  async sendButtons(to: string, text: string, buttons: ButtonRow[]): Promise<WhatsAppSendResult> {
    if (buttons.length === 0) throw AppError.validationError('At least one button is required');
    if (buttons.length > 3) throw AppError.validationError('WhatsApp supports a maximum of 3 buttons per message');

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    };
    return this.post(body);
  }

  async sendList(to: string, text: string, sections: ListSection[]): Promise<WhatsAppSendResult> {
    const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);
    if (totalRows === 0) throw AppError.validationError('At least one list item is required');
    if (totalRows > 10) throw AppError.validationError('WhatsApp supports a maximum of 10 list items');

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text },
        action: {
          button: 'View options',
          sections: sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      },
    };
    return this.post(body);
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption ? { caption } : {}),
      },
    };
    return this.post(body);
  }

  async markAsRead(messageId: string): Promise<void> {
    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };
    await this.post(body);
  }

  /**
   * Send a pre-approved WhatsApp template message.
   * Templates are required for business-initiated messages outside the 24-hour window.
   *
   * @param to          - Recipient phone in E.164 format
   * @param templateName - The approved template name (e.g. "morning_brief")
   * @param languageCode - BCP-47 language code (default "en_US")
   * @param components  - Template components (body params, header media, buttons, etc.)
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components: WhatsAppTemplateComponent[]
  ): Promise<WhatsAppSendResult> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    };
    return this.post(body);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  protected async post(body: unknown): Promise<WhatsAppSendResult> {
    const allowed = await acquireToken();
    if (!allowed) {
      throw AppError.rateLimitExceeded('WhatsApp rate limit reached (250 msg/s) — please retry shortly');
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const raw = (await response.json().catch(() => ({}))) as MetaErrorResponse;
      const code = raw.error?.code ?? 0;
      const known = META_ERROR_MESSAGES[code];
      const detail = known ?? raw.error?.message ?? `HTTP ${response.status}`;
      throw AppError.externalApiError(`WhatsApp send failed (${code}): ${detail}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }>; messages_status?: string };
    const messageId = data.messages?.[0]?.id ?? '';
    return { messageId, status: 'sent' };
  }
}
