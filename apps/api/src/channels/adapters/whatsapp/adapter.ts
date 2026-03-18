import type { InboundMessage, OutboundMessage } from '@kommand/shared';
import type { ChannelAdapter } from '../../adapter.interface.js';
import { config } from '../../../config/index.js';

// Normalized form produced by the inbound route after parsing Meta payload
export interface ParsedWhatsAppMessage {
  from: string;      // sender phone number (e.g. "14155552671")
  id: string;        // Meta message ID (wamid.xxx)
  text: string;      // extracted text (from text.body / button payload / list reply id)
  timestamp: string; // unix epoch string from Meta
}

export class WhatsAppAdapter implements ChannelAdapter {
  parseInbound(raw: unknown): InboundMessage {
    const msg = raw as ParsedWhatsAppMessage;
    return {
      // Internal ID — not stable across retries. For dedup on Meta re-delivery use channelMessageId (M4+).
      id: crypto.randomUUID(),
      // Phone number is used as userId until channel provisioning maps phone → user UUID (M3.3+)
      userId: msg.from,
      channelType: 'whatsapp',
      channelMessageId: msg.id,
      text: msg.text,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      metadata: { from: msg.from },
    };
  }

  formatOutbound(msg: OutboundMessage): unknown {
    if (msg.buttons?.length) {
      return {
        messaging_product: 'whatsapp',
        to: msg.userId,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.text },
          action: {
            buttons: msg.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      };
    }

    return {
      messaging_product: 'whatsapp',
      to: msg.userId,
      type: 'text',
      text: { body: msg.text },
    };
  }

  async send(formatted: unknown): Promise<void> {
    if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
      console.log('[WhatsAppAdapter] Credentials not configured — skipping send:', JSON.stringify(formatted));
      return;
    }

    const url = `https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formatted),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WhatsApp API error ${response.status}: ${body}`);
    }
  }
}
