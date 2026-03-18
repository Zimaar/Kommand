import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';
import type { ShopifyClient } from './client.js';

// ─── Period types & date helpers ─────────────────────────────────────────────

export type Period =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_7_days'
  | 'last_30_days';

export interface DateRange {
  start: string;
  end: string;
}

export function getTzOffset(date: Date, timezone: string): string {
  // Extract clock components in the target timezone using formatToParts, then
  // treat those components as UTC (via Date.UTC) to get the wall-clock epoch.
  // The difference between that and the actual UTC epoch is the UTC offset.
  // This avoids parsing locale strings with new Date(), which is server-TZ-dependent.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);

  const localAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );

  const offsetMin = Math.round((localAsUtc - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function shiftDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function getDateRange(period: Period, timezone: string): DateRange {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const [y, m] = todayStr.split('-').map(Number) as [number, number];
  const offset = getTzOffset(now, timezone);
  const iso = (d: string, t: string) => `${d}T${t}${offset}`;

  switch (period) {
    case 'today':
      return { start: iso(todayStr, '00:00:00'), end: iso(todayStr, '23:59:59') };

    case 'yesterday': {
      const yest = shiftDays(todayStr, -1);
      return { start: iso(yest, '00:00:00'), end: iso(yest, '23:59:59') };
    }

    case 'this_week': {
      const dow = new Date(`${todayStr}T12:00:00Z`).getUTCDay();
      const weekStart = shiftDays(todayStr, -(dow === 0 ? 6 : dow - 1));
      return { start: iso(weekStart, '00:00:00'), end: iso(todayStr, '23:59:59') };
    }

    case 'this_month': {
      const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
      return { start: iso(monthStart, '00:00:00'), end: iso(todayStr, '23:59:59') };
    }

    case 'last_7_days':
      return { start: iso(shiftDays(todayStr, -7), '00:00:00'), end: iso(todayStr, '23:59:59') };

    case 'last_30_days':
      return { start: iso(shiftDays(todayStr, -30), '00:00:00'), end: iso(todayStr, '23:59:59') };
  }
}

export function getPreviousDateRange(period: Period, timezone: string): DateRange {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const [y, m] = todayStr.split('-').map(Number) as [number, number];
  const offset = getTzOffset(now, timezone);
  const iso = (d: string, t: string) => `${d}T${t}${offset}`;

  switch (period) {
    case 'today': {
      const yest = shiftDays(todayStr, -1);
      return { start: iso(yest, '00:00:00'), end: iso(yest, '23:59:59') };
    }

    case 'yesterday': {
      const twoDaysAgo = shiftDays(todayStr, -2);
      return { start: iso(twoDaysAgo, '00:00:00'), end: iso(twoDaysAgo, '23:59:59') };
    }

    case 'this_week': {
      const dow = new Date(`${todayStr}T12:00:00Z`).getUTCDay();
      const thisWeekStart = shiftDays(todayStr, -(dow === 0 ? 6 : dow - 1));
      const prevWeekStart = shiftDays(thisWeekStart, -7);
      const prevWeekEnd = shiftDays(thisWeekStart, -1);
      return { start: iso(prevWeekStart, '00:00:00'), end: iso(prevWeekEnd, '23:59:59') };
    }

    case 'this_month': {
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      const prevMonthStart = `${py}-${String(pm).padStart(2, '0')}-01`;
      const prevMonthEnd = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);
      return { start: iso(prevMonthStart, '00:00:00'), end: iso(prevMonthEnd, '23:59:59') };
    }

    case 'last_7_days':
      return {
        start: iso(shiftDays(todayStr, -14), '00:00:00'),
        end: iso(shiftDays(todayStr, -8), '23:59:59'),
      };

    case 'last_30_days':
      return {
        start: iso(shiftDays(todayStr, -60), '00:00:00'),
        end: iso(shiftDays(todayStr, -31), '23:59:59'),
      };
  }
}

// ─── GraphQL types ────────────────────────────────────────────────────────────

interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

interface LineItemNode {
  title: string;
  quantity: number;
  originalUnitPriceSet: { shopMoney: MoneyV2 };
  variant: { product: { title: string } } | null;
}

export interface OrderNode {
  id: string;
  name: string;
  customer: { displayName: string } | null;
  email: string | null;
  totalPriceSet: { shopMoney: MoneyV2 };
  subtotalPriceSet: { shopMoney: MoneyV2 } | null;
  totalTaxSet: { shopMoney: MoneyV2 } | null;
  totalShippingPriceSet: { shopMoney: MoneyV2 } | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  createdAt: string;
  lineItems: { edges: Array<{ node: LineItemNode }> };
  shippingAddress: {
    address1: string | null;
    city: string | null;
    province: string | null;
    country: string | null;
    zip: string | null;
  } | null;
}

interface OrdersResponse {
  orders: {
    edges: Array<{ node: OrderNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const ORDERS_GQL = `
  query GetOrders($query: String!, $first: Int!, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          customer { displayName }
          email
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          displayFulfillmentStatus
          displayFinancialStatus
          createdAt
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                variant { product { title } }
              }
            }
          }
          shippingAddress { address1 city province country zip }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function fetchOrders(
  client: ShopifyClient,
  queryFilter: string,
  limit = 250
): Promise<OrderNode[]> {
  const all: OrderNode[] = [];
  let after: string | null = null;
  let remaining = limit;

  do {
    const batch = Math.min(remaining, 250);
    const data: OrdersResponse = await client.graphql<OrdersResponse>(ORDERS_GQL, {
      query: queryFilter,
      first: batch,
      after,
    });
    const edges = data.orders.edges;
    all.push(...edges.map((e: { node: OrderNode }) => e.node));
    remaining -= edges.length;
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  } while (remaining > 0);

  return all;
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const PeriodEnum = z.enum([
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_7_days',
  'last_30_days',
]);

const GetSalesSummaryInput = z.object({ period: PeriodEnum });
const GetRecentOrdersInput = z.object({
  limit: z.number().int().min(1).max(20).default(5),
  status: z.enum(['any', 'unfulfilled', 'fulfilled']).default('any'),
});
const GetOrderDetailsInput = z.object({ order_identifier: z.string().min(1) });
const ComparePeriodInput = z.object({ period_a: PeriodEnum, period_b: PeriodEnum });
const GetBestSellersInput = z.object({
  period: PeriodEnum.default('last_30_days'),
  limit: z.number().int().min(1).max(20).default(5),
});

// ─── Handler helpers ──────────────────────────────────────────────────────────

function sumRevenue(orders: OrderNode[]): number {
  return orders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function buildSalesSummary(
  client: ShopifyClient,
  period: Period,
  timezone: string,
  currency: string
) {
  const { start, end } = getDateRange(period, timezone);
  const orders = await fetchOrders(
    client,
    `created_at:>='${start}' created_at:<='${end}'`,
    250
  );
  const revenue = sumRevenue(orders);
  const orderCount = orders.length;
  return {
    revenue: round2(revenue),
    orderCount,
    averageOrderValue: orderCount > 0 ? round2(revenue / orderCount) : 0,
    currency: orders[0]?.totalPriceSet.shopMoney.currencyCode ?? currency,
    period,
    _orders: orders,
  };
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeGetSalesSummary(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetSalesSummaryInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const current = await buildSalesSummary(client, input.period, context.timezone, context.currency);
    const prev = getPreviousDateRange(input.period, context.timezone);
    const prevOrders = await fetchOrders(
      client,
      `created_at:>='${prev.start}' created_at:<='${prev.end}'`,
      250
    );
    const prevRevenue = sumRevenue(prevOrders);

    const { _orders: _o, ...summary } = current;
    const data = {
      ...summary,
      ...(prevRevenue > 0 || prevOrders.length > 0
        ? {
            comparedToPrevious: {
              revenue: round2(prevRevenue),
              change: percentChange(current.revenue, prevRevenue),
            },
          }
        : {}),
    };
    return { success: true, data };
  };
}

function makeGetRecentOrders(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetRecentOrdersInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    let queryFilter = 'status:any';
    if (input.status === 'unfulfilled') queryFilter = 'fulfillment_status:unfulfilled';
    else if (input.status === 'fulfilled') queryFilter = 'fulfillment_status:fulfilled';

    const orders = await fetchOrders(client, queryFilter, input.limit);

    const data = orders.slice(0, input.limit).map((o) => ({
      orderNumber: o.name,
      customerName: o.customer?.displayName ?? 'Guest',
      total: round2(parseFloat(o.totalPriceSet.shopMoney.amount)),
      currency: o.totalPriceSet.shopMoney.currencyCode,
      status: o.displayFulfillmentStatus,
      createdAt: o.createdAt,
      itemCount: o.lineItems.edges.length,
    }));

    return { success: true, data };
  };
}

function makeGetOrderDetails(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetOrderDetailsInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Normalize: ensure it starts with # for Shopify name query
    const identifier = input.order_identifier.startsWith('#')
      ? input.order_identifier
      : `#${input.order_identifier}`;

    const orders = await fetchOrders(client, `name:${identifier}`, 1);

    if (orders.length === 0) {
      return { success: false, error: `Order ${identifier} not found` };
    }

    const o = orders[0]!;
    const data = {
      orderNumber: o.name,
      customerName: o.customer?.displayName ?? 'Guest',
      customerEmail: o.email ?? null,
      total: round2(parseFloat(o.totalPriceSet.shopMoney.amount)),
      subtotal: o.subtotalPriceSet
        ? round2(parseFloat(o.subtotalPriceSet.shopMoney.amount))
        : null,
      tax: o.totalTaxSet ? round2(parseFloat(o.totalTaxSet.shopMoney.amount)) : null,
      shipping: o.totalShippingPriceSet
        ? round2(parseFloat(o.totalShippingPriceSet.shopMoney.amount))
        : null,
      currency: o.totalPriceSet.shopMoney.currencyCode,
      status: o.displayFulfillmentStatus,
      fulfillmentStatus: o.displayFulfillmentStatus,
      paymentStatus: o.displayFinancialStatus,
      items: o.lineItems.edges.map(({ node: li }) => ({
        title: li.title,
        quantity: li.quantity,
        price: round2(parseFloat(li.originalUnitPriceSet.shopMoney.amount)),
      })),
      createdAt: o.createdAt,
      shippingAddress: o.shippingAddress,
    };
    return { success: true, data };
  };
}

function makeComparePeriods(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = ComparePeriodInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const [a, b] = await Promise.all([
      buildSalesSummary(client, input.period_a, context.timezone, context.currency),
      buildSalesSummary(client, input.period_b, context.timezone, context.currency),
    ]);

    const { _orders: _oa, ...periodA } = a;
    const { _orders: _ob, ...periodB } = b;

    const data = {
      periodA,
      periodB,
      changes: {
        revenue: percentChange(a.revenue, b.revenue),
        orders: percentChange(a.orderCount, b.orderCount),
        aov: percentChange(a.averageOrderValue, b.averageOrderValue),
      },
    };
    return { success: true, data };
  };
}

function makeGetBestSellers(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetBestSellersInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const { start, end } = getDateRange(input.period, context.timezone);
    const orders = await fetchOrders(
      client,
      `created_at:>='${start}' created_at:<='${end}'`,
      250
    );

    const totals = new Map<string, { unitsSold: number; revenue: number }>();
    let grandRevenue = 0;

    for (const order of orders) {
      for (const { node: li } of order.lineItems.edges) {
        const productTitle = li.variant?.product.title ?? li.title;
        const lineRevenue = parseFloat(li.originalUnitPriceSet.shopMoney.amount) * li.quantity;
        const existing = totals.get(productTitle) ?? { unitsSold: 0, revenue: 0 };
        totals.set(productTitle, {
          unitsSold: existing.unitsSold + li.quantity,
          revenue: existing.revenue + lineRevenue,
        });
        grandRevenue += lineRevenue;
      }
    }

    const sorted = Array.from(totals.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, input.limit)
      .map(([productTitle, stats]) => ({
        productTitle,
        unitsSold: stats.unitsSold,
        revenue: round2(stats.revenue),
        percentOfTotal:
          grandRevenue > 0
            ? Math.round((stats.revenue / grandRevenue) * 1000) / 10
            : 0,
      }));

    return { success: true, data: sorted };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

const PERIOD_SCHEMA_PROP = {
  type: 'string',
  enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days'],
};

export function registerShopifyOrderTools(db: DB, registry: ToolRegistry): void {
  const tools: Parameters<ToolRegistry['register']>[0][] = [
    {
      name: 'get_sales_summary',
      description:
        'Get revenue, order count, and average order value for a time period. Use when the merchant asks about sales, revenue, or performance for today/this week/this month/last N days. Always compares to the previous equivalent period.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: { period: PERIOD_SCHEMA_PROP },
        required: ['period'],
      },
      handler: makeGetSalesSummary(db),
    },
    {
      name: 'get_recent_orders',
      description:
        'List the most recent orders with customer name, total, and fulfillment status. Use when the merchant asks to see recent or latest orders, or wants to check what orders came in.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
          status: { type: 'string', enum: ['any', 'unfulfilled', 'fulfilled'], default: 'any' },
        },
        required: [],
      },
      handler: makeGetRecentOrders(db),
    },
    {
      name: 'get_order_details',
      description:
        'Get full details for a single order including line items, customer, and shipping. Use when the merchant asks about a specific order number like "#1234" or "order 1234".',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          order_identifier: { type: 'string', description: 'Order number e.g. "#1234" or "1234"' },
        },
        required: ['order_identifier'],
      },
      handler: makeGetOrderDetails(db),
    },
    {
      name: 'compare_periods',
      description:
        'Compare sales metrics (revenue, orders, AOV) between two time periods. Use when the merchant asks how this week compares to last week, or any two-period comparison.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          period_a: PERIOD_SCHEMA_PROP,
          period_b: PERIOD_SCHEMA_PROP,
        },
        required: ['period_a', 'period_b'],
      },
      handler: makeComparePeriods(db),
    },
    {
      name: 'get_best_sellers',
      description:
        'Get top-selling products by revenue for a time period. Use when the merchant asks about best sellers, top products, or what is selling the most.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          period: { ...PERIOD_SCHEMA_PROP, default: 'last_30_days' },
          limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
        },
        required: [],
      },
      handler: makeGetBestSellers(db),
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}
