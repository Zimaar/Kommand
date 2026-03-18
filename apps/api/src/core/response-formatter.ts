import type { OutboundMessage } from '@kommand/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChartConfig {
  type: 'bar' | 'line' | 'pie' | 'doughnut';
  labels: string[];
  datasets: Array<{ label: string; data: number[]; backgroundColor?: string | string[] }>;
  title?: string;
  width?: number;
  height?: number;
}

const WHATSAPP_CHAR_LIMIT = 4096;

// ─── Channel formatters ───────────────────────────────────────────────────────

export class ResponseFormatter {
  formatForChannel(
    text: string,
    channelType: string,
    extras?: { buttons?: Array<{ id: string; title: string }>; imageUrl?: string }
  ): OutboundMessage {
    let formattedText: string;
    switch (channelType) {
      case 'whatsapp':
        formattedText = this.formatWhatsApp(text);
        break;
      case 'slack':
        formattedText = this.formatSlack(text);
        break;
      default:
        formattedText = this.formatPlainText(text);
    }

    return {
      userId: '', // caller sets this
      channelType: channelType as OutboundMessage['channelType'],
      text: formattedText,
      buttons: extras?.buttons,
      imageUrl: extras?.imageUrl,
    };
  }

  formatWhatsApp(text: string): string {
    let result = text
      // **bold** → *bold*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // ~~strikethrough~~ → ~strikethrough~
      .replace(/~~(.+?)~~/g, '~$1~')
      // inline `code` → ```code```
      .replace(/`([^`]+)`/g, '```$1```')
      // preserve line breaks (already \n in most cases)
      .replace(/\r\n/g, '\n');

    if (result.length > WHATSAPP_CHAR_LIMIT) {
      result = result.slice(0, WHATSAPP_CHAR_LIMIT - 3) + '...';
    }

    return result;
  }

  formatSlack(text: string): string {
    return text
      // Slack uses *bold* not **bold**, but mrkdwn actually supports both;
      // normalise **bold** → *bold* for consistency
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // _italic_ stays as-is (Slack supports _)
      // inline `code` stays as-is (Slack supports `)
      // fenced ```code``` stays as-is
      .replace(/\r\n/g, '\n');
  }

  formatPlainText(text: string): string {
    return text
      // remove **bold** markers
      .replace(/\*\*(.+?)\*\*/g, '$1')
      // remove *bold* / *italic* markers
      .replace(/\*(.+?)\*/g, '$1')
      // remove _italic_ markers
      .replace(/\b_(.+?)_\b/g, '$1')
      // remove inline `code`
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      // remove ~~strikethrough~~
      .replace(/~~(.+?)~~/g, '$1')
      // remove markdown links [text](url) → text
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  // ─── Smart helpers ──────────────────────────────────────────────────────────

  formatCurrency(amount: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }

  formatPercentChange(current: number, previous: number): string {
    if (previous === 0) return '→ flat';
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 0.05) return '→ flat';
    const sign = pct > 0 ? '↑' : '↓';
    return `${sign}${Math.abs(pct).toFixed(1)}%`;
  }

  formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 14) return 'last week';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  formatOrderSummary(orders: Array<Record<string, unknown>>): string {
    if (orders.length === 0) return 'No orders found.';

    return orders
      .map((o) => {
        const id = o['name'] ?? o['order_number'] ?? o['id'] ?? '—';
        const customer = o['customer_name'] ?? o['email'] ?? 'Unknown';
        const total = typeof o['total_price'] === 'number'
          ? `$${(o['total_price'] as number).toFixed(2)}`
          : o['total_price'] ?? '—';
        const status = o['fulfillment_status'] ?? o['status'] ?? '';
        return `📦 ${id}  ${customer}  ${total}  ${status}`.trimEnd();
      })
      .join('\n');
  }

  // ─── Chart URL (QuickChart.io) ──────────────────────────────────────────────

  generateChartUrl(config: ChartConfig): string {
    const chartConfig = {
      type: config.type,
      data: {
        labels: config.labels,
        datasets: config.datasets,
      },
      options: {
        plugins: {
          title: config.title
            ? { display: true, text: config.title }
            : undefined,
        },
      },
    };

    const encoded = encodeURIComponent(JSON.stringify(chartConfig));
    const w = config.width ?? 600;
    const h = config.height ?? 300;
    return `https://quickchart.io/chart?c=${encoded}&w=${w}&h=${h}&bkg=white`;
  }
}

export const responseFormatter = new ResponseFormatter();
