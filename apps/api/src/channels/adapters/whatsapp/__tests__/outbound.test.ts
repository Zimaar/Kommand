import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppSender } from '../outbound.js';
import { AppError } from '../../../../utils/errors.js';

// ─── Mock Redis (rate limiter always allows) ──────────────────────────────────

const mockRedis = { eval: vi.fn().mockResolvedValue(1) };
vi.mock('../../../../utils/redis.js', () => ({
  getRedisClient: vi.fn(() => mockRedis),
}));

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockSuccess(messageId = 'wamid.abc123') {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ messages: [{ id: messageId }] }),
  });
}

function mockApiError(code: number, message: string, status = 400) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: { code, message } }),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capturedBody(): unknown {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return JSON.parse(call[1].body as string);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WhatsAppSender', () => {
  let sender: WhatsAppSender;

  beforeEach(() => {
    mockFetch.mockReset();
    sender = new WhatsAppSender('12345678', 'test-access-token');
  });

  // ─── sendText ───────────────────────────────────────────────────────────────

  describe('sendText', () => {
    it('posts correct body to Meta messages endpoint', async () => {
      mockSuccess('wamid.text1');
      const result = await sender.sendText('14155552671', 'Hello!');

      const body = capturedBody() as Record<string, unknown>;
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('14155552671');
      expect(body.type).toBe('text');
      expect((body.text as Record<string, unknown>).body).toBe('Hello!');

      expect(result.messageId).toBe('wamid.text1');
      expect(result.status).toBe('sent');
    });

    it('uses correct API URL', async () => {
      mockSuccess();
      await sender.sendText('14155552671', 'hi');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toMatch(/graph\.facebook\.com\/v\d+\.\d+\/12345678\/messages/);
    });

    it('includes Authorization header', async () => {
      mockSuccess();
      await sender.sendText('14155552671', 'hi');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-access-token');
    });

    it('throws AppError on Meta error response', async () => {
      mockApiError(131026, 'Number not on WhatsApp');
      await expect(sender.sendText('99999', 'hi')).rejects.toMatchObject({
        code: 'EXTERNAL_API_ERROR',
        message: expect.stringContaining('131026'),
      });
    });

    it('uses known error message for recognised Meta error codes', async () => {
      mockApiError(131026, 'ignored message');
      await expect(sender.sendText('99999', 'hi')).rejects.toMatchObject({
        message: expect.stringContaining('not a valid WhatsApp account'),
      });
    });
  });

  // ─── sendButtons ────────────────────────────────────────────────────────────

  describe('sendButtons', () => {
    it('posts correct interactive button body', async () => {
      mockSuccess();
      await sender.sendButtons('14155552671', 'Pick one', [
        { id: 'a', title: 'Option A' },
        { id: 'b', title: 'Option B' },
      ]);

      const body = capturedBody() as Record<string, unknown>;
      expect(body.type).toBe('interactive');
      const interactive = body.interactive as Record<string, unknown>;
      expect(interactive.type).toBe('button');
      const action = interactive.action as Record<string, unknown>;
      expect((action.buttons as unknown[]).length).toBe(2);
    });

    it('truncates button titles to 20 chars', async () => {
      mockSuccess();
      await sender.sendButtons('14155552671', 'Pick', [
        { id: 'a', title: 'This title is way too long and should be cut' },
      ]);
      const body = capturedBody() as Record<string, unknown>;
      const interactive = body.interactive as Record<string, unknown>;
      const action = interactive.action as Record<string, unknown>;
      const btn = (action.buttons as Array<Record<string, unknown>>)[0];
      const reply = btn.reply as Record<string, unknown>;
      expect((reply.title as string).length).toBeLessThanOrEqual(20);
    });

    it('throws validation error when 0 buttons provided', async () => {
      await expect(sender.sendButtons('14155552671', 'text', [])).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('throws validation error when more than 3 buttons provided', async () => {
      const buttons = [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
        { id: '3', title: 'C' },
        { id: '4', title: 'D' },
      ];
      await expect(sender.sendButtons('14155552671', 'text', buttons)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('maximum of 3'),
      });
    });

    it('allows exactly 3 buttons', async () => {
      mockSuccess();
      await expect(
        sender.sendButtons('14155552671', 'text', [
          { id: '1', title: 'A' },
          { id: '2', title: 'B' },
          { id: '3', title: 'C' },
        ])
      ).resolves.toBeDefined();
    });
  });

  // ─── sendList ────────────────────────────────────────────────────────────────

  describe('sendList', () => {
    it('posts correct list body', async () => {
      mockSuccess();
      await sender.sendList('14155552671', 'Choose an order', [
        { title: 'Recent', rows: [{ id: 'o1', title: '#1001' }, { id: 'o2', title: '#1002' }] },
      ]);
      const body = capturedBody() as Record<string, unknown>;
      const interactive = body.interactive as Record<string, unknown>;
      expect(interactive.type).toBe('list');
    });

    it('throws validation error when more than 10 items across sections', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: `Item ${i}` }));
      await expect(
        sender.sendList('14155552671', 'Choose', [{ title: 'All', rows }])
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('maximum of 10'),
      });
    });
  });

  // ─── sendImage ───────────────────────────────────────────────────────────────

  describe('sendImage', () => {
    it('posts image type with link', async () => {
      mockSuccess();
      await sender.sendImage('14155552671', 'https://example.com/chart.png', 'Revenue chart');
      const body = capturedBody() as Record<string, unknown>;
      expect(body.type).toBe('image');
      const image = body.image as Record<string, unknown>;
      expect(image.link).toBe('https://example.com/chart.png');
      expect(image.caption).toBe('Revenue chart');
    });

    it('omits caption field when not provided', async () => {
      mockSuccess();
      await sender.sendImage('14155552671', 'https://example.com/img.png');
      const body = capturedBody() as Record<string, unknown>;
      const image = body.image as Record<string, unknown>;
      expect(image.caption).toBeUndefined();
    });
  });

  // ─── markAsRead ──────────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('posts read status with message_id', async () => {
      mockSuccess();
      await sender.markAsRead('wamid.msg123');
      const body = capturedBody() as Record<string, unknown>;
      expect(body.status).toBe('read');
      expect(body.message_id).toBe('wamid.msg123');
      expect(body.messaging_product).toBe('whatsapp');
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('throws RATE_LIMIT_EXCEEDED when token bucket is empty', async () => {
      mockRedis.eval.mockResolvedValueOnce(0); // no token available
      await expect(sender.sendText('14155552671', 'hi')).rejects.toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
      });
    });
  });
});
