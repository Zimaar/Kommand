import type { InboundMessage, OutboundMessage } from '@kommand/shared';
import type { ChannelAdapter } from '../../adapter.interface.js';
import { WhatsAppSender } from './outbound.js';
import { normalizePhoneNumber } from './phone.js';
import { config } from '../../../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// Normalized form produced by the inbound route after parsing Meta payload
export interface ParsedWhatsAppMessage {
  from: string;      // sender phone number (e.g. "14155552671")
  id: string;        // Meta message ID (wamid.xxx)
  text: string;      // extracted text (from text.body / button payload / list reply id)
  timestamp: string; // unix epoch string from Meta
}

// Discriminated union used internally between formatOutbound → send
export type FormattedWhatsApp =
  | { type: 'text';    to: string; text: string }
  | { type: 'buttons'; to: string; text: string; buttons: Array<{ id: string; title: string }> }
  | { type: 'list';    to: string; text: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { type: 'image';   to: string; imageUrl: string; caption?: string };

const MAX_WA_TEXT = 4096;

// ─── WhatsAppAdapter ──────────────────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  private sender: WhatsAppSender | null = null;
  /**
   * Parse the already-extracted `{ from, id, text, timestamp }` object
   * produced by the inbound route handler. Normalizes the sender phone to
   * E.164 and uses it as userId — the ingestion service resolves it to a DB
   * UUID via the channels table.
   */
  parseInbound(raw: unknown): InboundMessage {
    const msg = raw as ParsedWhatsAppMessage;
    const normalizedPhone = normalizePhoneNumber(msg.from);
    return {
      id: crypto.randomUUID(),
      userId: normalizedPhone,   // phone; resolved to UUID in ingestion service
      channelType: 'whatsapp',
      channelMessageId: msg.id,
      text: msg.text,
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      metadata: { from: normalizedPhone },
    };
  }

  /**
   * Formats an outbound message into a typed discriminated union:
   *   - imageUrl present            → image
   *   - buttons present, count ≤ 3 → button (interactive)
   *   - buttons present, count > 3  → list (single section)
   *   - otherwise                   → plain text
   * Text is truncated to 4096 chars (WhatsApp limit).
   */
  formatOutbound(msg: OutboundMessage): FormattedWhatsApp {
    const to = msg.userId; // normalizedPhone flows through from InboundMessage.userId
    const text = msg.text.slice(0, MAX_WA_TEXT);

    if (msg.imageUrl) {
      return { type: 'image', to, imageUrl: msg.imageUrl, caption: text || undefined };
    }

    if (msg.buttons?.length) {
      if (msg.buttons.length <= 3) {
        return { type: 'buttons', to, text, buttons: msg.buttons.map((b) => ({ id: b.id, title: b.title })) };
      }
      // >3 buttons → list message (max 10 items enforced by WhatsAppSender)
      return {
        type: 'list',
        to,
        text,
        sections: [{ title: 'Options', rows: msg.buttons.map((b) => ({ id: b.id, title: b.title })) }],
      };
    }

    return { type: 'text', to, text };
  }

  /** Dispatches the formatted message via WhatsAppSender. */
  async send(formatted: unknown): Promise<void> {
    if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
      return; // credentials not configured (dev/test env) — no-op
    }

    const msg = formatted as FormattedWhatsApp;
    this.sender ??= new WhatsAppSender(config.WHATSAPP_PHONE_NUMBER_ID, config.WHATSAPP_ACCESS_TOKEN);
    const sender = this.sender;

    switch (msg.type) {
      case 'text':    await sender.sendText(msg.to, msg.text); break;
      case 'buttons': await sender.sendButtons(msg.to, msg.text, msg.buttons); break;
      case 'list':    await sender.sendList(msg.to, msg.text, msg.sections); break;
      case 'image':   await sender.sendImage(msg.to, msg.imageUrl, msg.caption); break;
    }
  }
}
