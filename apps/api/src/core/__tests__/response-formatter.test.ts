import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseFormatter } from '../response-formatter.js';

describe('ResponseFormatter', () => {
  let fmt: ResponseFormatter;

  beforeEach(() => {
    fmt = new ResponseFormatter();
  });

  // ─── formatWhatsApp ─────────────────────────────────────────────────────────

  describe('formatWhatsApp', () => {
    it('converts **bold** to *bold*', () => {
      expect(fmt.formatWhatsApp('**Sales** today: $1,234')).toBe('*Sales* today: $1,234');
    });

    it('converts inline `code` to ```code```', () => {
      expect(fmt.formatWhatsApp('Run `npm install`')).toBe('Run ```npm install```');
    });

    it('converts ~~strike~~ to ~strike~', () => {
      expect(fmt.formatWhatsApp('~~old price~~')).toBe('~old price~');
    });

    it('preserves line breaks', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      expect(fmt.formatWhatsApp(input)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('truncates text exceeding 4096 chars with "..."', () => {
      const long = 'a'.repeat(5000);
      const result = fmt.formatWhatsApp(long);
      expect(result.length).toBe(4096);
      expect(result.endsWith('...')).toBe(true);
    });

    it('does not truncate text exactly at 4096 chars', () => {
      const exact = 'b'.repeat(4096);
      expect(fmt.formatWhatsApp(exact).length).toBe(4096);
      expect(fmt.formatWhatsApp(exact).endsWith('...')).toBe(false);
    });
  });

  // ─── formatSlack ────────────────────────────────────────────────────────────

  describe('formatSlack', () => {
    it('converts **bold** to *bold* for mrkdwn', () => {
      expect(fmt.formatSlack('**Revenue** is up')).toBe('*Revenue* is up');
    });

    it('preserves inline backtick code', () => {
      expect(fmt.formatSlack('Run `npm install`')).toBe('Run `npm install`');
    });

    it('preserves existing _italic_ markers', () => {
      expect(fmt.formatSlack('_Important_ note')).toBe('_Important_ note');
    });
  });

  // ─── formatPlainText ────────────────────────────────────────────────────────

  describe('formatPlainText', () => {
    it('strips **bold** markers', () => {
      expect(fmt.formatPlainText('**Revenue** today')).toBe('Revenue today');
    });

    it('strips *italic* markers', () => {
      expect(fmt.formatPlainText('*highlight* this')).toBe('highlight this');
    });

    it('strips inline `code`', () => {
      expect(fmt.formatPlainText('use `npm install`')).toBe('use npm install');
    });

    it('strips ~~strikethrough~~', () => {
      expect(fmt.formatPlainText('~~removed~~')).toBe('removed');
    });

    it('converts [link](url) to link text only', () => {
      expect(fmt.formatPlainText('[Click here](https://example.com)')).toBe('Click here');
    });
  });

  // ─── formatForChannel ───────────────────────────────────────────────────────

  describe('formatForChannel', () => {
    it('routes whatsapp through formatWhatsApp', () => {
      const msg = fmt.formatForChannel('**Hello**', 'whatsapp');
      expect(msg.text).toBe('*Hello*');
      expect(msg.channelType).toBe('whatsapp');
    });

    it('routes slack through formatSlack', () => {
      const msg = fmt.formatForChannel('**Hello**', 'slack');
      expect(msg.text).toBe('*Hello*');
    });

    it('routes unknown channel through plainText', () => {
      const msg = fmt.formatForChannel('**Hello**', 'email');
      expect(msg.text).toBe('Hello');
    });

    it('includes buttons in outbound message', () => {
      const msg = fmt.formatForChannel('Choose:', 'whatsapp', {
        buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
      });
      expect(msg.buttons).toHaveLength(2);
      expect(msg.buttons![0]!.title).toBe('Yes');
    });

    it('includes imageUrl in outbound message', () => {
      const msg = fmt.formatForChannel('Chart:', 'whatsapp', {
        imageUrl: 'https://quickchart.io/chart?c={}',
      });
      expect(msg.imageUrl).toBe('https://quickchart.io/chart?c={}');
    });
  });

  // ─── formatCurrency ─────────────────────────────────────────────────────────

  describe('formatCurrency', () => {
    it('formats USD correctly', () => {
      expect(fmt.formatCurrency(1234.56, 'USD')).toBe('$1,234.56');
    });

    it('formats AED correctly', () => {
      const result = fmt.formatCurrency(1234.56, 'AED');
      expect(result).toContain('1,234.56');
      expect(result).toContain('AED');
    });

    it('formats whole numbers with two decimal places', () => {
      expect(fmt.formatCurrency(1000, 'USD')).toBe('$1,000.00');
    });
  });

  // ─── formatPercentChange ────────────────────────────────────────────────────

  describe('formatPercentChange', () => {
    it('shows ↑ for positive growth', () => {
      expect(fmt.formatPercentChange(112, 100)).toBe('↑12.0%');
    });

    it('shows ↓ for decline', () => {
      expect(fmt.formatPercentChange(95, 100)).toBe('↓5.0%');
    });

    it('shows → flat when no change', () => {
      expect(fmt.formatPercentChange(100, 100)).toBe('→ flat');
    });

    it('returns → flat when previous is zero', () => {
      expect(fmt.formatPercentChange(50, 0)).toBe('→ flat');
    });
  });

  // ─── formatRelativeTime ─────────────────────────────────────────────────────

  describe('formatRelativeTime', () => {
    it('returns "just now" for < 60 seconds ago', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 30_000))).toBe('just now');
    });

    it('returns "X minutes ago"', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 5 * 60_000))).toBe('5 minutes ago');
    });

    it('returns "1 minute ago" (singular)', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 90_000))).toBe('1 minute ago');
    });

    it('returns "X hours ago"', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 3 * 3_600_000))).toBe('3 hours ago');
    });

    it('returns "yesterday" for ~24h ago', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 25 * 3_600_000))).toBe('yesterday');
    });

    it('returns "X days ago" for 2-6 days', () => {
      expect(fmt.formatRelativeTime(new Date(Date.now() - 3 * 86_400_000))).toBe('3 days ago');
    });
  });

  // ─── formatOrderSummary ─────────────────────────────────────────────────────

  describe('formatOrderSummary', () => {
    it('returns fallback for empty array', () => {
      expect(fmt.formatOrderSummary([])).toBe('No orders found.');
    });

    it('formats orders as multi-line summary', () => {
      const orders = [
        { name: '#1001', customer_name: 'Ahmed', total_price: 145.5, fulfillment_status: 'fulfilled' },
        { name: '#1002', customer_name: 'Sara', total_price: 89, fulfillment_status: 'unfulfilled' },
      ];
      const result = fmt.formatOrderSummary(orders);
      expect(result).toContain('#1001');
      expect(result).toContain('Ahmed');
      expect(result).toContain('145.50');
      expect(result).toContain('#1002');
      expect(result.split('\n')).toHaveLength(2);
    });
  });

  // ─── generateChartUrl ───────────────────────────────────────────────────────

  describe('generateChartUrl', () => {
    it('returns a QuickChart URL', () => {
      const url = fmt.generateChartUrl({
        type: 'bar',
        labels: ['Mon', 'Tue'],
        datasets: [{ label: 'Revenue', data: [100, 200] }],
      });
      expect(url).toContain('quickchart.io/chart');
      expect(url).toContain('w=600');
      expect(url).toContain('h=300');
    });

    it('respects custom width and height', () => {
      const url = fmt.generateChartUrl({
        type: 'line',
        labels: [],
        datasets: [],
        width: 800,
        height: 400,
      });
      expect(url).toContain('w=800');
      expect(url).toContain('h=400');
    });
  });
});
