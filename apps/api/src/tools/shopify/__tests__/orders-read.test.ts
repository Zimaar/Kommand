import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDateRange,
  getPreviousDateRange,
  shiftDays,
  getTzOffset,
  fetchOrders,
  registerShopifyOrderTools,
  type OrderNode,
} from '../orders-read.js';
import type { ShopifyClient } from '../client.js';
import type { ToolContext } from '@kommand/shared';
import { ToolRegistry } from '../../../core/tool-registry.js';

// ─── Module mock (hoisted) ────────────────────────────────────────────────────
// vi.mock is hoisted — the factory must not reference local variables.
// We expose a mutable ref so each test can swap out the client.

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
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    createdAt: '2024-01-15T10:00:00Z',
    lineItems: {
      edges: [
        {
          node: {
            title: 'Widget A',
            quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'USD' } },
            variant: { product: { title: 'Widget A' } },
          },
        },
      ],
    },
    shippingAddress: {
      address1: '123 Main St',
      city: 'Springfield',
      province: 'IL',
      country: 'US',
      zip: '62701',
    },
    ...overrides,
  };
}

/** Build a ShopifyClient mock that returns `orders` as a single page */
function makeClient(orders: OrderNode[]): ShopifyClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
    rest: vi.fn(),
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

const UTC = 'UTC';

// ─── shiftDays ────────────────────────────────────────────────────────────────

describe('shiftDays', () => {
  it('shifts forward', () => {
    expect(shiftDays('2024-01-28', 3)).toBe('2024-01-31');
  });
  it('shifts backward across month boundary (leap year)', () => {
    expect(shiftDays('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('shifts across year boundary', () => {
    expect(shiftDays('2024-01-01', -1)).toBe('2023-12-31');
  });
});

// ─── getTzOffset ──────────────────────────────────────────────────────────────

describe('getTzOffset', () => {
  it('returns +00:00 for UTC', () => {
    expect(getTzOffset(new Date('2024-06-15T12:00:00Z'), 'UTC')).toBe('+00:00');
  });
  it('returns -05:00 for US Eastern in January (standard time)', () => {
    expect(getTzOffset(new Date('2024-01-15T12:00:00Z'), 'America/New_York')).toBe('-05:00');
  });
  it('returns -04:00 for US Eastern in June (daylight saving time)', () => {
    expect(getTzOffset(new Date('2024-06-15T12:00:00Z'), 'America/New_York')).toBe('-04:00');
  });
  it('returns +05:30 for Asia/Kolkata (non-whole-hour offset)', () => {
    expect(getTzOffset(new Date('2024-06-15T12:00:00Z'), 'Asia/Kolkata')).toBe('+05:30');
  });
});

// ─── getDateRange ─────────────────────────────────────────────────────────────

describe('getDateRange', () => {
  // Fake "today" = 2024-06-15 (Saturday)
  const FAKE_TODAY = '2024-06-15';

  beforeEach(() => {
    // Override format() so date-range helpers treat today as FAKE_TODAY, but
    // preserve formatToParts() so getTzOffset (which needs real time components)
    // continues to work correctly.
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const real = new Real(...args);
      return { ...real, format: () => FAKE_TODAY, formatToParts: real.formatToParts.bind(real) } as Intl.DateTimeFormat;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[Period: string, startContains: string, endContains: string]> = [
    ['today', '2024-06-15T00:00:00', '2024-06-15T23:59:59'],
    ['yesterday', '2024-06-14T00:00:00', '2024-06-14T23:59:59'],
    ['last_7_days', '2024-06-08T00:00:00', '2024-06-15T23:59:59'],
    ['last_30_days', '2024-05-16T00:00:00', '2024-06-15T23:59:59'],
    ['this_week', '2024-06-10T00:00:00', '2024-06-15T23:59:59'], // Mon 10th → Sat 15th
    ['this_month', '2024-06-01T00:00:00', '2024-06-15T23:59:59'],
  ];

  it.each(cases)(
    'getDateRange("%s") → start %s, end %s',
    (period, startContains, endContains) => {
      // Type assertion needed because Period is a union — string literal matches
      const range = getDateRange(period as Parameters<typeof getDateRange>[0], UTC);
      expect(range.start).toContain(startContains);
      expect(range.end).toContain(endContains);
    }
  );
});

// ─── getPreviousDateRange ─────────────────────────────────────────────────────

describe('getPreviousDateRange', () => {
  const FAKE_TODAY = '2024-06-15';

  beforeEach(() => {
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const real = new Real(...args);
      return { ...real, format: () => FAKE_TODAY, formatToParts: real.formatToParts.bind(real) } as Intl.DateTimeFormat;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[Period: string, startContains: string, endContains: string]> = [
    ['today', '2024-06-14T00:00:00', '2024-06-14T23:59:59'],
    ['yesterday', '2024-06-13T00:00:00', '2024-06-13T23:59:59'],
    ['last_7_days', '2024-06-01T00:00:00', '2024-06-07T23:59:59'],
    ['last_30_days', '2024-04-16T00:00:00', '2024-05-15T23:59:59'],
    ['this_week', '2024-06-03T00:00:00', '2024-06-09T23:59:59'], // prev Mon–Sun
    ['this_month', '2024-05-01T00:00:00', '2024-05-31T23:59:59'],
  ];

  it.each(cases)(
    'getPreviousDateRange("%s") → start %s, end %s',
    (period, startContains, endContains) => {
      const range = getPreviousDateRange(period as Parameters<typeof getPreviousDateRange>[0], UTC);
      expect(range.start).toContain(startContains);
      expect(range.end).toContain(endContains);
    }
  );
});

// ─── fetchOrders ──────────────────────────────────────────────────────────────

describe('fetchOrders', () => {
  it('returns orders from a single page', async () => {
    const client = makeClient([makeOrder(), makeOrder({ name: '#1002' })]);
    const result = await fetchOrders(client, 'status:any', 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('#1001');
  });

  it('paginates when hasNextPage is true', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        orders: {
          edges: [{ node: makeOrder() }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockResolvedValueOnce({
        orders: {
          edges: [{ node: makeOrder({ name: '#1002' }) }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const client = { graphql } as unknown as ShopifyClient;
    const result = await fetchOrders(client, 'status:any', 500);
    expect(result).toHaveLength(2);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: 'cursor-1' })
    );
  });

  it('passes the query filter through to graphql', async () => {
    const client = makeClient([]);
    await fetchOrders(client, 'fulfillment_status:unfulfilled', 10);
    expect(client.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: 'fulfillment_status:unfulfilled' })
    );
  });
});

// ─── registerShopifyOrderTools ────────────────────────────────────────────────

describe('registerShopifyOrderTools', () => {
  it('registers all 5 tools', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('get_sales_summary');
    expect(names).toContain('get_recent_orders');
    expect(names).toContain('get_order_details');
    expect(names).toContain('compare_periods');
    expect(names).toContain('get_best_sellers');
  });

  it('all tools have confirmationTier 0 (read-only)', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    registry.getAll().forEach((tool) => {
      expect(tool.confirmationTier).toBe(0);
    });
  });
});

// ─── get_sales_summary ────────────────────────────────────────────────────────

describe('get_sales_summary', () => {
  beforeEach(() => {
    mockGetShopifyClient.mockReset();
  });

  it('aggregates revenue, orderCount and aov', async () => {
    const orders = [
      makeOrder({ totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeOrder({ totalPriceSet: { shopMoney: { amount: '200.50', currencyCode: 'USD' } } }),
    ];
    mockGetShopifyClient.mockResolvedValue(makeClient(orders));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_sales_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      revenue: number;
      orderCount: number;
      averageOrderValue: number;
      currency: string;
    };
    expect(data.revenue).toBe(300.5);
    expect(data.orderCount).toBe(2);
    expect(data.averageOrderValue).toBe(150.25);
    expect(data.currency).toBe('USD');
  });

  it('includes comparedToPrevious when previous period has orders', async () => {
    const currentOrders = [
      makeOrder({ totalPriceSet: { shopMoney: { amount: '200.00', currencyCode: 'USD' } } }),
    ];
    const prevOrders = [
      makeOrder({ totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
    ];

    // First two graphql calls = current period; next two = previous period
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        orders: {
          edges: currentOrders.map((n) => ({ node: n })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })
      .mockResolvedValueOnce({
        orders: {
          edges: prevOrders.map((n) => ({ node: n })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    mockGetShopifyClient.mockResolvedValue({ graphql } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_sales_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      comparedToPrevious?: { revenue: number; change: number };
    };
    expect(data.comparedToPrevious).toBeDefined();
    expect(data.comparedToPrevious!.revenue).toBe(100);
    expect(data.comparedToPrevious!.change).toBe(100); // 100% increase
  });
});

// ─── get_recent_orders ────────────────────────────────────────────────────────

describe('get_recent_orders', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns formatted order list', async () => {
    mockGetShopifyClient.mockResolvedValue(makeClient([makeOrder()]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_recent_orders')!.handler(
      { limit: 5, status: 'any' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{
      orderNumber: string;
      customerName: string;
      total: number;
      itemCount: number;
    }>;
    expect(data[0]!.orderNumber).toBe('#1001');
    expect(data[0]!.customerName).toBe('Alice Smith');
    expect(data[0]!.total).toBe(100);
    expect(data[0]!.itemCount).toBe(1);
  });

  it('passes fulfillment_status filter for "unfulfilled"', async () => {
    const graphql = vi.fn().mockResolvedValue({
      orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    await registry.get('get_recent_orders')!.handler({ status: 'unfulfilled' }, makeContext());

    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: 'fulfillment_status:unfulfilled' })
    );
  });
});

// ─── get_order_details ────────────────────────────────────────────────────────

describe('get_order_details', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('prefixes # to bare order numbers', async () => {
    mockGetShopifyClient.mockResolvedValue(makeClient([makeOrder()]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_order_details')!.handler(
      { order_identifier: '1001' },
      makeContext()
    );
    expect(result.success).toBe(true);
  });

  it('returns full detail fields', async () => {
    mockGetShopifyClient.mockResolvedValue(makeClient([makeOrder()]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_order_details')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      tax: number;
      shipping: number;
      items: Array<{ title: string; quantity: number; price: number }>;
    };
    expect(data.tax).toBe(10);
    expect(data.shipping).toBe(5);
    expect(data.items[0]!.title).toBe('Widget A');
    expect(data.items[0]!.quantity).toBe(2);
  });

  it('returns success:false when order not found', async () => {
    mockGetShopifyClient.mockResolvedValue(makeClient([]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_order_details')!.handler(
      { order_identifier: '#9999' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('#9999');
  });
});

// ─── get_best_sellers ─────────────────────────────────────────────────────────

describe('get_best_sellers', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('sorts by revenue descending and calculates percentOfTotal', async () => {
    const order = makeOrder({
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
    });
    mockGetShopifyClient.mockResolvedValue(makeClient([order]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_best_sellers')!.handler(
      { period: 'last_30_days', limit: 5 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{
      productTitle: string;
      unitsSold: number;
      revenue: number;
      percentOfTotal: number;
    }>;
    // Widget B ($50) > Widget A ($30)
    expect(data[0]!.productTitle).toBe('Widget B');
    expect(data[0]!.revenue).toBe(50);
    expect(data[0]!.unitsSold).toBe(1);
    expect(data[0]!.percentOfTotal).toBe(62.5);
    expect(data[1]!.productTitle).toBe('Widget A');
    expect(data[1]!.revenue).toBe(30);
    expect(data[1]!.percentOfTotal).toBe(37.5);
  });

  it('uses product title from variant when available', async () => {
    const order = makeOrder({
      lineItems: {
        edges: [
          {
            node: {
              title: 'Widget A - Blue',
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } },
              variant: { product: { title: 'Widget A' } },
            },
          },
        ],
      },
    });
    mockGetShopifyClient.mockResolvedValue(makeClient([order]));

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('get_best_sellers')!.handler(
      { period: 'today', limit: 5 },
      makeContext()
    );
    const data = result.data as Array<{ productTitle: string }>;
    expect(data[0]!.productTitle).toBe('Widget A'); // product title, not variant title
  });
});

// ─── compare_periods ──────────────────────────────────────────────────────────

describe('compare_periods', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns periodA, periodB, and changes', async () => {
    let call = 0;
    const graphql = vi.fn().mockImplementation(() => {
      call++;
      // Calls 1-2 are period_a fetches; calls 3-4 are period_b fetches
      const amount = call <= 2 ? '100.00' : '200.00';
      return Promise.resolve({
        orders: {
          edges: [
            {
              node: makeOrder({
                totalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
              }),
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    });
    mockGetShopifyClient.mockResolvedValue({ graphql } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyOrderTools({} as never, registry);
    const result = await registry.get('compare_periods')!.handler(
      { period_a: 'this_week', period_b: 'last_7_days' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      periodA: { period: string; revenue: number };
      periodB: { period: string; revenue: number };
      changes: { revenue: number; orders: number; aov: number };
    };
    expect(data.periodA.period).toBe('this_week');
    expect(data.periodB.period).toBe('last_7_days');
    expect(typeof data.changes.revenue).toBe('number');
    expect(typeof data.changes.orders).toBe('number');
    expect(typeof data.changes.aov).toBe('number');
  });
});
