import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerShopifyAnalyticsTools } from '../analytics.js';
import type { ShopifyClient } from '../client.js';
import type { ToolContext } from '@kommand/shared';
import type { OrderNode } from '../orders-read.js';
import { ToolRegistry } from '../../../core/tool-registry.js';

// ─── Module mock (hoisted) ────────────────────────────────────────────────────

const mockGetShopifyClient = vi.fn();

vi.mock('../index.js', () => ({
  getShopifyClient: (...args: unknown[]) => mockGetShopifyClient(...args),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeOrder(overrides: Partial<OrderNode> = {}): OrderNode {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    customer: { displayName: 'Alice Smith' },
    email: 'alice@example.com',
    totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
    subtotalPriceSet: { shopMoney: { amount: '85.00', currencyCode: 'USD' } },
    totalTaxSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
    displayFulfillmentStatus: 'FULFILLED',
    displayFinancialStatus: 'PAID',
    createdAt: '2026-03-18T10:00:00Z',
    lineItems: {
      edges: [
        {
          node: {
            title: 'Widget A',
            quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
            variant: { product: { title: 'Widget A' } },
          },
        },
      ],
    },
    shippingAddress: null,
    ...overrides,
  };
}

/** Build a ShopifyClient mock whose graphql always returns orders from the given list. */
function makeOrderClient(orders: OrderNode[]): ShopifyClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
    rest: vi.fn().mockResolvedValue({ count: 5 }),
  } as unknown as ShopifyClient;
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    storeId: 'store-1',
    timezone: 'UTC',
    currency: 'USD',
    ...overrides,
  };
}

function makeRegistry() {
  const registry = new ToolRegistry();
  registerShopifyAnalyticsTools({} as never, registry);
  return registry;
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe('registerShopifyAnalyticsTools', () => {
  it('registers both tools', () => {
    const registry = makeRegistry();
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('get_business_summary');
    expect(names).toContain('get_trends');
  });

  it('both tools are tier 0', () => {
    const registry = makeRegistry();
    registry.getAll().forEach((t) => expect(t.confirmationTier).toBe(0));
  });
});

// ─── get_business_summary ─────────────────────────────────────────────────────

describe('get_business_summary', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns coherent summary from period orders', async () => {
    const periodOrders = [
      makeOrder({ totalPriceSet: { shopMoney: { amount: '200.00', currencyCode: 'USD' } } }),
      makeOrder({ totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
    ];
    const prevOrders = [
      makeOrder({ totalPriceSet: { shopMoney: { amount: '250.00', currencyCode: 'USD' } } }),
    ];

    // graphql call 1 = period orders, call 2 = prev period orders
    let graphqlCall = 0;
    const graphql = vi.fn().mockImplementation(() => {
      graphqlCall++;
      const orders = graphqlCall === 1 ? periodOrders : prevOrders;
      return Promise.resolve({
        orders: {
          edges: orders.map((node) => ({ node })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    });
    const rest = vi.fn().mockResolvedValue({ count: 3 }); // 3 new customers

    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('get_business_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      period: string;
      orders: { count: number; revenue: number; averageOrderValue: number; currency: string; vsLastPeriod: { change: number; previousRevenue: number } };
      bestSellers: Array<{ productTitle: string; unitsSold: number; revenue: number }>;
      newCustomers: number;
      unfulfilledOrders: number;
      alerts: string[];
    };

    expect(data.period).toBe('today');
    expect(data.orders.count).toBe(2);
    expect(data.orders.revenue).toBe(300);
    expect(data.orders.averageOrderValue).toBe(150);
    expect(data.orders.currency).toBe('USD');
    expect(data.orders.vsLastPeriod.previousRevenue).toBe(250);
    expect(data.orders.vsLastPeriod.change).toBe(20); // (300-250)/250 * 100 = 20%
    expect(data.newCustomers).toBe(3);
    expect(data.unfulfilledOrders).toBe(0);
    expect(Array.isArray(data.alerts)).toBe(true);
  });

  it('counts unfulfilled orders correctly', async () => {
    const orders = [
      makeOrder({ displayFulfillmentStatus: 'UNFULFILLED' }),
      makeOrder({ displayFulfillmentStatus: 'UNFULFILLED' }),
      makeOrder({ displayFulfillmentStatus: 'FULFILLED' }),
    ];

    const graphql = vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('get_business_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    const data = result.data as { unfulfilledOrders: number };
    expect(data.unfulfilledOrders).toBe(2);
  });

  it('adds alert when 5+ orders are unfulfilled', async () => {
    const orders = Array.from({ length: 6 }, () =>
      makeOrder({ displayFulfillmentStatus: 'UNFULFILLED' })
    );

    const graphql = vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('get_business_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    const data = result.data as { alerts: string[] };
    expect(data.alerts.some((a) => a.includes('unfulfilled'))).toBe(true);
  });

  it('aggregates best sellers from period orders', async () => {
    const orders = [
      makeOrder({
        lineItems: {
          edges: [
            {
              node: {
                title: 'Widget A',
                quantity: 3,
                originalUnitPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
                variant: { product: { title: 'Widget A' } },
              },
            },
            {
              node: {
                title: 'Widget B',
                quantity: 1,
                originalUnitPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
                variant: { product: { title: 'Widget B' } },
              },
            },
          ],
        },
      }),
    ];

    const graphql = vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('get_business_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    const data = result.data as {
      bestSellers: Array<{ productTitle: string; unitsSold: number; revenue: number }>;
    };
    // Widget B ($50) > Widget A ($30) by revenue
    expect(data.bestSellers[0]!.productTitle).toBe('Widget B');
    expect(data.bestSellers[0]!.revenue).toBe(50);
    expect(data.bestSellers[1]!.productTitle).toBe('Widget A');
    expect(data.bestSellers[1]!.revenue).toBe(30);
  });

  it('returns zero AOV and no alerts when period has no orders', async () => {
    const graphql = vi.fn().mockResolvedValue({
      orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('get_business_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      orders: { count: number; revenue: number; averageOrderValue: number };
      alerts: string[];
    };
    expect(data.orders.count).toBe(0);
    expect(data.orders.revenue).toBe(0);
    expect(data.orders.averageOrderValue).toBe(0);
    expect(data.alerts).toHaveLength(0);
  });
});

// ─── get_trends ───────────────────────────────────────────────────────────────

describe('get_trends', () => {
  beforeEach(() => {
    mockGetShopifyClient.mockReset();
    // Freeze "today" to 2026-03-18 UTC so date math is deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns one data point per day with correct date range', async () => {
    mockGetShopifyClient.mockResolvedValue(makeOrderClient([]));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 5 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { dataPoints: Array<{ date: string; value: number }> };
    expect(data.dataPoints).toHaveLength(5);
    expect(data.dataPoints[0]!.date).toBe('2026-03-14'); // today - 4
    expect(data.dataPoints[4]!.date).toBe('2026-03-18'); // today
  });

  it('groups orders into correct day buckets', async () => {
    const orders = [
      makeOrder({ createdAt: '2026-03-17T08:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-17T20:00:00Z', totalPriceSet: { shopMoney: { amount: '200.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z', totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 3 },
      makeContext()
    );

    const data = result.data as { dataPoints: Array<{ date: string; value: number }> };
    const mar16 = data.dataPoints.find((dp) => dp.date === '2026-03-16')!;
    const mar17 = data.dataPoints.find((dp) => dp.date === '2026-03-17')!;
    const mar18 = data.dataPoints.find((dp) => dp.date === '2026-03-18')!;

    expect(mar16.value).toBe(0);    // no orders
    expect(mar17.value).toBe(300);  // 100 + 200
    expect(mar18.value).toBe(50);
  });

  it('reports order count metric correctly', async () => {
    const orders = [
      makeOrder({ createdAt: '2026-03-18T08:00:00Z' }),
      makeOrder({ createdAt: '2026-03-18T09:00:00Z' }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z' }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'orders', days: 2 },
      makeContext()
    );

    const data = result.data as { dataPoints: Array<{ date: string; value: number }> };
    const today = data.dataPoints.find((dp) => dp.date === '2026-03-18')!;
    expect(today.value).toBe(3);
  });

  it('calculates upward trend when second half is higher', async () => {
    // 4 days: low, low, high, high → up trend
    const orders = [
      makeOrder({ createdAt: '2026-03-15T10:00:00Z', totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-16T10:00:00Z', totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-17T10:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 4 },
      makeContext()
    );

    const data = result.data as { trend: string };
    expect(data.trend).toBe('up');
  });

  it('calculates downward trend when second half is lower', async () => {
    const orders = [
      makeOrder({ createdAt: '2026-03-15T10:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-16T10:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-17T10:00:00Z', totalPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z', totalPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 4 },
      makeContext()
    );

    const data = result.data as { trend: string };
    expect(data.trend).toBe('down');
  });

  it('returns peak and trough with correct dates', async () => {
    const orders = [
      makeOrder({ createdAt: '2026-03-16T10:00:00Z', totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-17T10:00:00Z', totalPriceSet: { shopMoney: { amount: '200.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z', totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 3 },
      makeContext()
    );

    const data = result.data as {
      peak: { value: number; date: string };
      trough: { value: number; date: string } | null;
      average: number;
    };
    expect(data.peak.value).toBe(200);
    expect(data.peak.date).toBe('2026-03-17');
    expect(data.trough!.value).toBe(10);
    expect(data.trough!.date).toBe('2026-03-18');
    expect(data.average).toBe(86.67); // round2((50 + 200 + 10) / 3)
  });

  it('returns null trough when all days have no orders', async () => {
    mockGetShopifyClient.mockResolvedValue(makeOrderClient([]));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 3 },
      makeContext()
    );

    const data = result.data as { trough: null; peak: { value: number } };
    expect(data.trough).toBeNull();
    expect(data.peak.value).toBe(0);
  });

  it('returns dayOverDay changes', async () => {
    const orders = [
      makeOrder({ createdAt: '2026-03-17T10:00:00Z', totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ createdAt: '2026-03-18T10:00:00Z', totalPriceSet: { shopMoney: { amount: '150.00', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeOrderClient(orders));

    const registry = makeRegistry();
    const result = await registry.get('get_trends')!.handler(
      { metric: 'revenue', days: 2 },
      makeContext()
    );

    const data = result.data as {
      dayOverDay: Array<{ date: string; change: number }>;
    };
    expect(data.dayOverDay).toHaveLength(1);
    expect(data.dayOverDay[0]!.date).toBe('2026-03-18');
    expect(data.dayOverDay[0]!.change).toBe(50); // (150-100)/100 * 100 = 50%
  });
});

// ─── shopify-tools barrel ─────────────────────────────────────────────────────

describe('registerAllShopifyTools (barrel)', () => {
  it('registers all expected tool names', async () => {
    const { registerAllShopifyTools } = await import('../shopify-tools.js');
    const registry = new ToolRegistry();
    registerAllShopifyTools({} as never, registry);
    const names = new Set(registry.getAll().map((t) => t.name));

    // Orders read
    expect(names.has('get_sales_summary')).toBe(true);
    expect(names.has('get_recent_orders')).toBe(true);
    expect(names.has('get_order_details')).toBe(true);
    expect(names.has('compare_periods')).toBe(true);
    expect(names.has('get_best_sellers')).toBe(true);
    // Orders write
    expect(names.has('refund_order')).toBe(true);
    expect(names.has('cancel_order')).toBe(true);
    expect(names.has('fulfill_order')).toBe(true);
    // Products
    expect(names.has('get_products')).toBe(true);
    expect(names.has('get_product_inventory')).toBe(true);
    expect(names.has('update_product_price')).toBe(true);
    expect(names.has('update_inventory')).toBe(true);
    // Customers
    expect(names.has('get_customer_summary')).toBe(true);
    expect(names.has('search_customers')).toBe(true);
    expect(names.has('get_top_customers')).toBe(true);
    // Discounts
    expect(names.has('list_active_discounts')).toBe(true);
    expect(names.has('create_discount')).toBe(true);
    expect(names.has('disable_discount')).toBe(true);
    // Analytics
    expect(names.has('get_business_summary')).toBe(true);
    expect(names.has('get_trends')).toBe(true);
  });
});
