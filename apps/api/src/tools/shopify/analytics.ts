import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';
import {
  fetchOrders,
  getDateRange,
  getPreviousDateRange,
  getTzOffset,
  shiftDays,
  type OrderNode,
} from './orders-read.js';
import { round2, percentChange, sumRevenue } from './math.js';

// ─── Zod input schemas ────────────────────────────────────────────────────────

const PeriodEnum = z.enum([
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_7_days',
  'last_30_days',
]);

const GetBusinessSummaryInput = z.object({
  period: PeriodEnum.default('today'),
});

const GetTrendsInput = z.object({
  metric: z.enum(['revenue', 'orders', 'aov']),
  days: z.number().int().min(2).max(30).default(7),
});


function buildBestSellers(
  orders: OrderNode[],
  limit: number
): Array<{ productTitle: string; unitsSold: number; revenue: number }> {
  const totals = new Map<string, { unitsSold: number; revenue: number }>();
  for (const order of orders) {
    for (const { node: li } of order.lineItems.edges) {
      const title = li.variant?.product.title ?? li.title;
      const lineRev = parseFloat(li.originalUnitPriceSet.shopMoney.amount) * li.quantity;
      const existing = totals.get(title) ?? { unitsSold: 0, revenue: 0 };
      totals.set(title, {
        unitsSold: existing.unitsSold + li.quantity,
        revenue: existing.revenue + lineRev,
      });
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, limit)
    .map(([productTitle, stats]) => ({
      productTitle,
      unitsSold: stats.unitsSold,
      revenue: round2(stats.revenue),
    }));
}

function orderToLocalDate(order: OrderNode, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(order.createdAt)
  );
}

// ─── get_business_summary handler ────────────────────────────────────────────

function makeGetBusinessSummary(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetBusinessSummaryInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const { start, end } = getDateRange(input.period, context.timezone);
    const prev = getPreviousDateRange(input.period, context.timezone);

    // Fetch period orders, previous orders, and new customer count in parallel
    const [periodOrders, prevOrders, newCustomersData] = await Promise.all([
      fetchOrders(client, `created_at:>='${start}' created_at:<='${end}'`, 250),
      fetchOrders(client, `created_at:>='${prev.start}' created_at:<='${prev.end}'`, 250),
      client.rest<{ count: number }>(
        'GET',
        `/customers/count.json?created_at_min=${encodeURIComponent(start)}&created_at_max=${encodeURIComponent(end)}`
      ),
    ]);

    const revenue = round2(sumRevenue(periodOrders));
    const prevRevenue = sumRevenue(prevOrders);
    const orderCount = periodOrders.length;
    const aov = orderCount > 0 ? round2(revenue / orderCount) : 0;
    const currency =
      periodOrders[0]?.totalPriceSet.shopMoney.currencyCode ?? context.currency;

    const unfulfilledOrders = periodOrders.filter(
      (o) => o.displayFulfillmentStatus === 'UNFULFILLED'
    ).length;

    const bestSellers = buildBestSellers(periodOrders, 3);

    // Proactive alerts
    const alerts: string[] = [];
    if (unfulfilledOrders >= 5) {
      alerts.push(`${unfulfilledOrders} orders are unfulfilled`);
    }
    const revenueChange = percentChange(revenue, prevRevenue);
    if (prevRevenue > 0 && revenueChange < -20) {
      alerts.push(`Revenue is down ${Math.abs(revenueChange)}% vs last period`);
    }

    return {
      success: true,
      data: {
        period: input.period,
        orders: {
          count: orderCount,
          revenue,
          averageOrderValue: aov,
          currency,
          vsLastPeriod: {
            change: revenueChange,
            previousRevenue: round2(prevRevenue),
          },
        },
        bestSellers,
        newCustomers: newCustomersData.count,
        unfulfilledOrders,
        alerts,
      },
    };
  };
}

// ─── get_trends handler ───────────────────────────────────────────────────────

function makeGetTrends(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetTrendsInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Build date range: today and the N-1 days before it
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone }).format(now);
    const startStr = shiftDays(todayStr, -(input.days - 1));
    const offset = getTzOffset(now, context.timezone);
    const start = `${startStr}T00:00:00${offset}`;
    const end = `${todayStr}T23:59:59${offset}`;

    const orders = await fetchOrders(
      client,
      `created_at:>='${start}' created_at:<='${end}'`,
      500
    );

    // Group by local date
    const byDate = new Map<string, OrderNode[]>();
    for (const order of orders) {
      const date = orderToLocalDate(order, context.timezone);
      const arr = byDate.get(date) ?? [];
      arr.push(order);
      byDate.set(date, arr);
    }

    // Build complete data points for all N days (including zero days)
    const dataPoints: Array<{ date: string; value: number; orderCount: number }> = [];
    for (let i = 0; i < input.days; i++) {
      const date = shiftDays(startStr, i);
      const dayOrders = byDate.get(date) ?? [];
      const dayRevenue = round2(sumRevenue(dayOrders));
      const dayOrderCount = dayOrders.length;
      const dayAov = dayOrderCount > 0 ? round2(dayRevenue / dayOrderCount) : 0;

      let value: number;
      switch (input.metric) {
        case 'revenue':
          value = dayRevenue;
          break;
        case 'orders':
          value = dayOrderCount;
          break;
        case 'aov':
          value = dayAov;
          break;
      }
      dataPoints.push({ date, value, orderCount: dayOrderCount });
    }

    // Aggregate stats — exclude zero-value days from average/trough
    const values = dataPoints.map((dp) => dp.value);
    const nonZero = values.filter((v) => v > 0);
    const average =
      nonZero.length > 0
        ? round2(nonZero.reduce((s, v) => s + v, 0) / nonZero.length)
        : 0;
    const peak = values.length > 0 ? Math.max(...values) : 0;
    const trough = nonZero.length > 0 ? Math.min(...nonZero) : 0;
    const peakDay = dataPoints.find((dp) => dp.value === peak)?.date ?? null;
    const troughDay =
      nonZero.length > 0 ? (dataPoints.find((dp) => dp.value === trough)?.date ?? null) : null;

    // Trend: compare first-half avg to second-half avg
    const half = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, half).filter((v) => v > 0);
    const secondHalf = values.slice(half).filter((v) => v > 0);
    const firstAvg =
      firstHalf.length > 0 ? firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length : 0;
    const secondAvg =
      secondHalf.length > 0 ? secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length : 0;

    let trend: 'up' | 'down' | 'flat' = 'flat';
    if (firstAvg > 0) {
      const trendPct = ((secondAvg - firstAvg) / firstAvg) * 100;
      if (trendPct > 5) trend = 'up';
      else if (trendPct < -5) trend = 'down';
    }

    // Day-over-day changes
    const dayOverDay = dataPoints.slice(1).map((dp, i) => ({
      date: dp.date,
      change: percentChange(dp.value, dataPoints[i]!.value),
    }));

    return {
      success: true,
      data: {
        metric: input.metric,
        days: input.days,
        dataPoints,
        trend,
        average,
        peak: { value: peak, date: peakDay },
        trough: trough > 0 ? { value: trough, date: troughDay } : null,
        dayOverDay,
      },
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerShopifyAnalyticsTools(db: DB, registry: ToolRegistry): void {
  registry.register({
    name: 'get_business_summary',
    description:
      'Get a full business snapshot for a time period: revenue, order count, AOV vs last period, top 3 best-selling products, new customers, unfulfilled orders, and any alerts. Use when the merchant asks "how\'s today going?", "give me a summary", or wants a general business overview.',
    platform: 'shopify',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days'],
          default: 'today',
        },
      },
      required: [],
    },
    handler: makeGetBusinessSummary(db),
  });

  registry.register({
    name: 'get_trends',
    description:
      'Get daily trend data for a specific metric over the last N days. Returns data points, trend direction (up/down/flat), peak day, trough day, and day-over-day changes. Use when the merchant asks about trends, momentum, or how a metric has been moving.',
    platform: 'shopify',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        metric: {
          type: 'string',
          enum: ['revenue', 'orders', 'aov'],
          description: 'Metric to trend: revenue (total sales), orders (order count), aov (average order value)',
        },
        days: {
          type: 'number',
          minimum: 2,
          maximum: 30,
          default: 7,
          description: 'Number of days to look back (default 7)',
        },
      },
      required: ['metric'],
    },
    handler: makeGetTrends(db),
  });
}
