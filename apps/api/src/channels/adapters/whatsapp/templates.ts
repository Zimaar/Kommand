/**
 * WhatsApp Message Templates + Rich Formatting
 *
 * Covers three concerns:
 *  1. Template messages  — business-initiated messages outside the 24-hour window
 *  2. Rich text formatters — structured WhatsApp-formatted strings (morning brief, alerts, etc.)
 *  3. Chart URLs         — mobile-optimised QuickChart image links
 */

import type { WhatsAppSender, WhatsAppTemplateComponent } from './outbound.js';

// ─── Domain types ─────────────────────────────────────────────────────────────

/** Mirrors the `data` shape returned by `get_business_summary` Shopify tool. */
export interface BusinessSummary {
  period: string;
  storeName?: string;
  ownerName?: string;
  orders: {
    count: number;
    revenue: number;
    averageOrderValue: number;
    currency: string;
    vsLastPeriod: {
      change: number;          // percentage, may be negative
      previousRevenue: number;
    };
  };
  bestSellers: Array<{ productTitle: string; unitsSold: number; revenue: number }>;
  newCustomers: number;
  unfulfilledOrders: number;
  alerts: string[];
}

export interface OrderData {
  number: string;
  customer: string;
  currency: string;
  total: number;
}

export interface ProductData {
  name: string;
  count: number;
  dailyRate: number;   // average units consumed per day
}

export interface PeriodSummary {
  label: string;       // e.g. "This Week", "Last Week"
  revenue: number;
  orders: number;
  aov: number;
  currency: string;
}

// ─── Template definitions ─────────────────────────────────────────────────────
// Each definition records the positional params ({{1}}, {{2}}...) expected by
// the pre-approved Meta template, and a builder that converts a named params
// map into the ordered components array.

interface TemplateDef {
  /** Human-readable description for docs/debugging */
  description: string;
  /** Language code (BCP-47) */
  language: string;
  /** Ordered list of param names that map to {{1}}, {{2}} … in the template body */
  params: string[];
}

const TEMPLATE_REGISTRY: Record<string, TemplateDef> = {
  morning_brief: {
    description: 'Good morning {name}! Here\'s your business update: {body}',
    language: 'en_US',
    params: ['name', 'body'],
  },
  alert: {
    description: '⚡ Alert for {store_name}: {body}',
    language: 'en_US',
    params: ['store_name', 'body'],
  },
  confirmation: {
    description: 'Please confirm: {body}',
    language: 'en_US',
    params: ['body'],
  },
};

// ─── 1. Template message sender ───────────────────────────────────────────────

/**
 * Send a pre-approved WhatsApp template message.
 *
 * Templates are required for business-initiated messages sent **outside** the
 * 24-hour customer service window. The named `params` map is converted to
 * positional parameters ({{1}}, {{2}}…) in the template body.
 *
 * @example
 * await sendTemplate(sender, '+971501234567', 'morning_brief', {
 *   name: 'Sarah',
 *   body: 'Revenue today: AED 12,500',
 * });
 */
export async function sendTemplate(
  sender: WhatsAppSender,
  to: string,
  templateName: string,
  params: Record<string, string>
): Promise<void> {
  const def = TEMPLATE_REGISTRY[templateName];
  if (!def) {
    throw new Error(
      `Unknown template "${templateName}". Registered templates: ${Object.keys(TEMPLATE_REGISTRY).join(', ')}`
    );
  }

  // Build positional text parameters in the order defined by the template
  const textParams: WhatsAppTemplateComponent['parameters'] = def.params.map((key) => ({
    type: 'text' as const,
    text: params[key] ?? '',
  }));

  const components: WhatsAppTemplateComponent[] = [
    { type: 'body', parameters: textParams },
  ];

  await sender.sendTemplate(to, templateName, def.language, components);
}

// ─── 2. Rich formatting helpers ───────────────────────────────────────────────

/**
 * Formats a number as a compact currency string.
 * e.g. 12500.5 → "AED 12,500.50"
 */
function fmtCurrency(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a percentage change with a directional arrow.
 * e.g. 12.5 → "↑12.5%", -5 → "↓5.0%", 0 → "→0.0%"
 */
function fmtChange(pct: number): string {
  if (pct > 0) return `↑${pct.toFixed(1)}%`;
  if (pct < 0) return `↓${Math.abs(pct).toFixed(1)}%`;
  return `→0.0%`;
}

/**
 * Builds a morning-brief WhatsApp message from a `BusinessSummary`.
 *
 * Example output:
 * ```
 * 🌅 Good morning, Sarah!
 * Here's your Kommand update for today 📊
 *
 * 💰 Revenue
 * AED 12,500.00  ↑12.5% vs last period
 *
 * 📦 Orders
 * 45 orders · AOV: AED 277.78
 * ⚠️  2 unfulfilled
 *
 * ⭐ Top Sellers
 * 1. Blue T-Shirt — 18 units · AED 2,700.00
 * 2. Cap — 10 units · AED 1,500.00
 * 3. Hoodie — 8 units · AED 2,400.00
 *
 * 👥 New customers: 7
 *
 * 🚨 Alerts
 * • Revenue is down 25.0% vs last period
 * ```
 */
export function formatMorningBrief(data: BusinessSummary): string {
  const { orders, bestSellers, newCustomers, unfulfilledOrders, alerts } = data;
  const greeting = data.ownerName ? `Good morning, ${data.ownerName}!` : 'Good morning!';
  const storeLine = data.storeName ? ` for *${data.storeName}*` : '';

  const lines: string[] = [
    `🌅 ${greeting}`,
    `Here's your Kommand update${storeLine} 📊`,
    '',
    '💰 *Revenue*',
    `${fmtCurrency(orders.revenue, orders.currency)}  ${fmtChange(orders.vsLastPeriod.change)} vs last period`,
    '',
    '📦 *Orders*',
    `${orders.count} orders · AOV: ${fmtCurrency(orders.averageOrderValue, orders.currency)}`,
  ];

  if (unfulfilledOrders > 0) {
    lines.push(`⚠️  ${unfulfilledOrders} unfulfilled`);
  }

  if (bestSellers.length > 0) {
    lines.push('', '⭐ *Top Sellers*');
    bestSellers.forEach((item, i) => {
      lines.push(
        `${i + 1}. ${item.productTitle} — ${item.unitsSold} units · ${fmtCurrency(item.revenue, orders.currency)}`
      );
    });
  }

  lines.push('', `👥 New customers: ${newCustomers}`);

  if (alerts.length > 0) {
    lines.push('', '🚨 *Alerts*');
    alerts.forEach((a) => lines.push(`• ${a}`));
  }

  return lines.join('\n');
}

/**
 * Formats a new-order notification.
 *
 * Example: "📦 New order #1042 from Jane Smith — AED 350.00"
 */
export function formatOrderNotification(order: OrderData): string {
  return `📦 New order #${order.number} from ${order.customer} — ${fmtCurrency(order.total, order.currency)}`;
}

/**
 * Formats a low-inventory alert.
 *
 * Example: "⚠️ Low stock: Blue T-Shirt (M) has 5 units left (avg 2.3/day = ~2 days supply)"
 */
export function formatInventoryAlert(product: ProductData): string {
  const daysLeft =
    product.dailyRate > 0 ? Math.floor(product.count / product.dailyRate) : null;
  const daysStr =
    daysLeft !== null
      ? ` (avg ${product.dailyRate.toFixed(1)}/day = ~${daysLeft} day${daysLeft === 1 ? '' : 's'} supply)`
      : '';
  return `⚠️ Low stock: *${product.name}* has ${product.count} unit${product.count === 1 ? '' : 's'} left${daysStr}`;
}

/**
 * Formats a side-by-side comparison of two periods.
 *
 * Example:
 * ```
 * 📊 This Week vs Last Week
 *
 * Revenue   AED 12,500  ↑  AED 11,200
 * Orders    45          ↑  38
 * AOV       AED 278     ↓  AED 295
 * ```
 */
export function formatComparison(periodA: PeriodSummary, periodB: PeriodSummary): string {
  const revChange = periodB.revenue > 0 ? ((periodA.revenue - periodB.revenue) / periodB.revenue) * 100 : 0;
  const ordChange = periodB.orders > 0 ? ((periodA.orders - periodB.orders) / periodB.orders) * 100 : 0;
  const aovChange = periodB.aov > 0 ? ((periodA.aov - periodB.aov) / periodB.aov) * 100 : 0;

  const arrow = (pct: number) => (pct > 0 ? '↑' : pct < 0 ? '↓' : '→');

  const revA = fmtCurrency(periodA.revenue, periodA.currency);
  const revB = fmtCurrency(periodB.revenue, periodB.currency);
  const aovA = fmtCurrency(periodA.aov, periodA.currency);
  const aovB = fmtCurrency(periodB.aov, periodB.currency);

  const lines = [
    `📊 *${periodA.label}* vs *${periodB.label}*`,
    '',
    `💰 Revenue`,
    `  ${revA}  ${arrow(revChange)}  ${revB}  (${fmtChange(revChange)})`,
    '',
    `📦 Orders`,
    `  ${periodA.orders}  ${arrow(ordChange)}  ${periodB.orders}  (${fmtChange(ordChange)})`,
    '',
    `🛒 AOV`,
    `  ${aovA}  ${arrow(aovChange)}  ${aovB}  (${fmtChange(aovChange)})`,
  ];

  return lines.join('\n');
}

// ─── 3. Chart generation (QuickChart) ─────────────────────────────────────────

export interface ChartDataPoint {
  date: string;   // display label, e.g. "Mon", "Mar 12"
  value: number;
}

/**
 * Generates a QuickChart URL for a mobile-optimised line chart.
 *
 * The returned URL resolves to a PNG image that can be sent via `sendImage`.
 * Charts are sized for WhatsApp mobile (400×220), use a dark blue line on white,
 * and apply large axis labels for readability on small screens.
 *
 * @example
 * const url = generateSalesChart(dataPoints, 'Revenue (AED)');
 * await sender.sendImage(to, url, 'Sales trend');
 */
export function generateSalesChart(dataPoints: ChartDataPoint[], title: string): string {
  const labels = dataPoints.map((p) => p.date);
  const values = dataPoints.map((p) => p.value);

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: title,
          data: values,
          fill: true,
          backgroundColor: 'rgba(37, 99, 235, 0.12)',   // light blue fill
          borderColor: '#2563EB',                         // Kommand blue
          borderWidth: 2,
          pointBackgroundColor: '#2563EB',
          pointRadius: 3,
          tension: 0.3,                                   // slight curve
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: title,
          font: { size: 14, weight: 'bold' },
          color: '#1E293B',
        },
      },
      scales: {
        x: {
          ticks: { font: { size: 11 }, color: '#475569' },
          grid: { display: false },
        },
        y: {
          beginAtZero: false,
          ticks: { font: { size: 11 }, color: '#475569' },
          grid: { color: '#E2E8F0' },
        },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&width=400&height=220&bkg=white&format=png`;
}
