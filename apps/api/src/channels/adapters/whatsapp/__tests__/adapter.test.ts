import { describe, it, expect } from 'vitest';
import { WhatsAppAdapter } from '../adapter.js';
import { normalizePhoneNumber } from '../phone.js';
import type { OutboundMessage } from '@kommand/shared';

// ─── normalizePhoneNumber ─────────────────────────────────────────────────────

describe('normalizePhoneNumber', () => {
  it('returns E.164 unchanged', () => {
    expect(normalizePhoneNumber('+14155552671')).toBe('+14155552671');
  });

  it('strips spaces from E.164', () => {
    expect(normalizePhoneNumber('+971 50 123 4567')).toBe('+971501234567');
  });

  it('converts 00-prefix to +', () => {
    expect(normalizePhoneNumber('00971501234567')).toBe('+971501234567');
  });

  it('handles local number with defaultCountryCode', () => {
    expect(normalizePhoneNumber('0501234567', '971')).toBe('+971501234567');
  });

  it('adds + to bare international digits', () => {
    expect(normalizePhoneNumber('14155552671')).toBe('+14155552671');
  });

  it('strips hyphens and dots', () => {
    expect(normalizePhoneNumber('+1-415-555-2671')).toBe('+14155552671');
    expect(normalizePhoneNumber('+1.415.555.2671')).toBe('+14155552671');
  });

  it('strips parentheses', () => {
    expect(normalizePhoneNumber('+1 (415) 555-2671')).toBe('+14155552671');
  });
});

// ─── WhatsAppAdapter.parseInbound ─────────────────────────────────────────────

describe('WhatsAppAdapter.parseInbound', () => {
  const adapter = new WhatsAppAdapter();

  it('maps a real Meta webhook message object to InboundMessage', () => {
    const raw = {
      from: '14155552671',
      id: 'wamid.HBgLMTQxNTU1NTI2NzEVAgASGCA',
      text: 'Hello Kommand!',
      timestamp: '1741000000',
    };

    const msg = adapter.parseInbound(raw);

    expect(msg.userId).toBe('+14155552671');          // normalized E.164
    expect(msg.channelType).toBe('whatsapp');
    expect(msg.channelMessageId).toBe(raw.id);
    expect(msg.text).toBe('Hello Kommand!');
    expect(msg.timestamp).toEqual(new Date(1741000000 * 1000));
    expect((msg.metadata as Record<string, string>)?.from).toBe('+14155552671');
    expect(typeof msg.id).toBe('string');              // UUID assigned
  });

  it('normalizes UAE phone with 00-prefix', () => {
    const raw = { from: '00971501234567', id: 'wamid.1', text: 'hi', timestamp: '1741000000' };
    const msg = adapter.parseInbound(raw);
    expect(msg.userId).toBe('+971501234567');
  });

  it('normalizes phone with spaces', () => {
    const raw = { from: '+971 50 123 4567', id: 'wamid.2', text: 'hi', timestamp: '1741000000' };
    const msg = adapter.parseInbound(raw);
    expect(msg.userId).toBe('+971501234567');
  });
});

// ─── WhatsAppAdapter.formatOutbound ──────────────────────────────────────────

describe('WhatsAppAdapter.formatOutbound', () => {
  const adapter = new WhatsAppAdapter();

  function outbound(overrides: Partial<OutboundMessage>): OutboundMessage {
    return {
      userId: '+14155552671',
      channelType: 'whatsapp',
      text: 'Hello!',
      ...overrides,
    };
  }

  it('formats plain text message', () => {
    const result = adapter.formatOutbound(outbound({})) as { type: string; text: string };
    expect(result.type).toBe('text');
    expect(result.text).toBe('Hello!');
  });

  it('formats button message for ≤3 buttons', () => {
    const result = adapter.formatOutbound(
      outbound({ buttons: [{ id: 'a', title: 'Yes' }, { id: 'b', title: 'No' }] })
    ) as { type: string; buttons: unknown[] };
    expect(result.type).toBe('buttons');
    expect(result.buttons).toHaveLength(2);
  });

  it('formats list message for >3 buttons', () => {
    const result = adapter.formatOutbound(
      outbound({
        buttons: [
          { id: '1', title: 'A' }, { id: '2', title: 'B' },
          { id: '3', title: 'C' }, { id: '4', title: 'D' },
        ],
      })
    ) as { type: string; sections: Array<{ rows: unknown[] }> };
    expect(result.type).toBe('list');
    expect(result.sections[0]?.rows).toHaveLength(4);
  });

  it('formats image message when imageUrl present', () => {
    const result = adapter.formatOutbound(
      outbound({ imageUrl: 'https://example.com/chart.png', text: 'Revenue chart' })
    ) as { type: string; imageUrl: string; caption: string };
    expect(result.type).toBe('image');
    expect(result.imageUrl).toBe('https://example.com/chart.png');
    expect(result.caption).toBe('Revenue chart');
  });

  it('truncates text to 4096 chars', () => {
    const longText = 'x'.repeat(5000);
    const result = adapter.formatOutbound(outbound({ text: longText })) as { text: string };
    expect(result.text.length).toBe(4096);
  });

  it('sets to from msg.userId', () => {
    const result = adapter.formatOutbound(outbound({})) as { to: string };
    expect(result.to).toBe('+14155552671');
  });
});
