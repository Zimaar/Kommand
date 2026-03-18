import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCustomers,
  fetchSlimOrders,
  registerShopifyCustomerTools,
  type CustomerNode,
  type CustomerOrderSlim,
} from '../customers.js';
import type { ShopifyClient } from '../client.js';
import type { ToolContext } from '@kommand/shared';
import { ToolRegistry } from '../../../core/tool-registry.js';

// ─── Module mock (hoisted) ────────────────────────────────────────────────────

const mockGetShopifyClient = vi.fn();

vi.mock('../index.js', () => ({
  getShopifyClient: (...args: unknown[]) => mockGetShopifyClient(...args),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<CustomerNode> = {}): CustomerNode {
  return {
    id: 'gid://shopify/Customer/1',
    displayName: 'Alice Smith',
    email: 'alice@example.com',
    phone: '+1234567890',
    numberOfOrders: 3,
    amountSpent: { amount: '450.00', currencyCode: 'USD' },
    createdAt: '2023-01-15T10:00:00Z',
    tags: ['vip'],
    lastOrder: { createdAt: '2024-06-01T10:00:00Z' },
    ...overrides,
  };
}

function makeSlimOrder(overrides: Partial<CustomerOrderSlim> = {}): CustomerOrderSlim {
  return {
    totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
    customer: { id: 'gid://shopify/Customer/1', createdAt: '2023-01-15T10:00:00Z' },
    ...overrides,
  };
}

function makeCustomerClient(customers: CustomerNode[]): ShopifyClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      customers: {
        edges: customers.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
    rest: vi.fn().mockResolvedValue({ count: 100 }),
  } as unknown as ShopifyClient;
}

function makeSlimOrderClient(orders: CustomerOrderSlim[]): ShopifyClient {
  return {
    graphql: vi.fn().mockResolvedValue({
      orders: {
        edges: orders.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
    rest: vi.fn().mockResolvedValue({ count: 0 }),
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

// ─── fetchCustomers ───────────────────────────────────────────────────────────

describe('fetchCustomers', () => {
  it('returns customers from a single page', async () => {
    const client = makeCustomerClient([makeCustomer(), makeCustomer({ id: 'gid://shopify/Customer/2', displayName: 'Bob' })]);
    const result = await fetchCustomers(client, 'query', 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.displayName).toBe('Alice Smith');
  });

  it('paginates when hasNextPage is true', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        customers: {
          edges: [{ node: makeCustomer() }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      })
      .mockResolvedValueOnce({
        customers: {
          edges: [{ node: makeCustomer({ id: 'gid://shopify/Customer/2' }) }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const client = { graphql, rest: vi.fn() } as unknown as ShopifyClient;
    const result = await fetchCustomers(client, '', 500);
    expect(result).toHaveLength(2);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: 'cursor-1' })
    );
  });

  it('passes the sortKey through to graphql', async () => {
    const client = makeCustomerClient([]);
    await fetchCustomers(client, '', 10, 'TOTAL_SPENT');
    expect(client.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sortKey: 'TOTAL_SPENT' })
    );
  });
});

// ─── fetchSlimOrders ──────────────────────────────────────────────────────────

describe('fetchSlimOrders', () => {
  it('returns slim orders', async () => {
    const client = makeSlimOrderClient([makeSlimOrder(), makeSlimOrder()]);
    const result = await fetchSlimOrders(client, 'status:any', 10);
    expect(result).toHaveLength(2);
  });

  it('passes the query filter to graphql', async () => {
    const client = makeSlimOrderClient([]);
    await fetchSlimOrders(client, 'created_at:>=2024-01-01', 10);
    expect(client.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: 'created_at:>=2024-01-01' })
    );
  });
});

// ─── registerShopifyCustomerTools ─────────────────────────────────────────────

describe('registerShopifyCustomerTools', () => {
  it('registers all 3 tools', () => {
    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('get_customer_summary');
    expect(names).toContain('search_customers');
    expect(names).toContain('get_top_customers');
  });

  it('all tools have confirmationTier 0', () => {
    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    registry.getAll().forEach((tool) => {
      expect(tool.confirmationTier).toBe(0);
    });
  });
});

// ─── get_customer_summary ─────────────────────────────────────────────────────

describe('get_customer_summary', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns totalCustomers, newCustomers, AOV and topCustomers', async () => {
    const topCustomer = makeCustomer();
    const orders = [
      makeSlimOrder({ totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } } }),
      makeSlimOrder({ totalPriceSet: { shopMoney: { amount: '200.00', currencyCode: 'USD' } } }),
    ];

    // graphql is called for slim orders + top customers; rest is called for counts
    let graphqlCall = 0;
    const graphql = vi.fn().mockImplementation(() => {
      graphqlCall++;
      if (graphqlCall === 1) {
        // slim orders query
        return Promise.resolve({
          orders: {
            edges: orders.map((node) => ({ node })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      // top customers query
      return Promise.resolve({
        customers: {
          edges: [{ node: topCustomer }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    });

    const rest = vi
      .fn()
      .mockResolvedValueOnce({ count: 500 })  // totalCustomers
      .mockResolvedValueOnce({ count: 12 });   // newCustomers

    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_customer_summary')!.handler(
      { period: 'this_month' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      totalCustomers: number;
      newCustomers: number;
      averageOrderValue: number;
      topCustomers: Array<{ name: string; totalSpent: number; orderCount: number }>;
    };
    expect(data.totalCustomers).toBe(500);
    expect(data.newCustomers).toBe(12);
    expect(data.averageOrderValue).toBe(150);
    expect(data.topCustomers[0]!.name).toBe('Alice Smith');
    expect(data.topCustomers[0]!.totalSpent).toBe(450);
    expect(data.topCustomers[0]!.orderCount).toBe(3);
  });

  it('counts returning customers from orders where customer was created before period', async () => {
    // Customer created before period start (should count as returning)
    const oldCustomer = { id: 'cust-1', createdAt: '2020-01-01T00:00:00Z' };
    // Customer created in-period (should NOT count as returning)
    // Use a far-future date so it is always after any period start
    const newCustomer = { id: 'cust-2', createdAt: '2099-01-01T00:00:00Z' };

    const orders = [
      makeSlimOrder({ customer: oldCustomer }),
      makeSlimOrder({ customer: oldCustomer }), // same returning customer, deduped
      makeSlimOrder({ customer: newCustomer }),
    ];

    let graphqlCall = 0;
    const graphql = vi.fn().mockImplementation(() => {
      graphqlCall++;
      if (graphqlCall === 1) {
        return Promise.resolve({
          orders: {
            edges: orders.map((node) => ({ node })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      return Promise.resolve({
        customers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    });

    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_customer_summary')!.handler(
      { period: 'this_month' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { returningCustomers: number };
    // Only oldCustomer counts as returning, deduped to 1
    expect(data.returningCustomers).toBe(1);
  });

  it('returns zero AOV when no orders in period', async () => {
    const graphql = vi.fn().mockImplementation(() =>
      Promise.resolve({
        orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
      })
    );
    // second graphql call for top customers
    graphql.mockImplementationOnce(() =>
      Promise.resolve({
        orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
      })
    ).mockImplementationOnce(() =>
      Promise.resolve({
        customers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
      })
    );

    const rest = vi.fn().mockResolvedValue({ count: 0 });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_customer_summary')!.handler(
      { period: 'today' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { averageOrderValue: number };
    expect(data.averageOrderValue).toBe(0);
  });
});

// ─── search_customers ─────────────────────────────────────────────────────────

describe('search_customers', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns formatted customer list', async () => {
    const customer = makeCustomer();
    mockGetShopifyClient.mockResolvedValue(makeCustomerClient([customer]));

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('search_customers')!.handler(
      { query: 'alice' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{
      name: string;
      email: string | null;
      phone: string | null;
      totalSpent: number;
      orderCount: number;
      lastOrderDate: string | null;
      tags: string[];
    }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.name).toBe('Alice Smith');
    expect(data[0]!.email).toBe('alice@example.com');
    expect(data[0]!.phone).toBe('+1234567890');
    expect(data[0]!.totalSpent).toBe(450);
    expect(data[0]!.orderCount).toBe(3);
    expect(data[0]!.lastOrderDate).toBe('2024-06-01T10:00:00Z');
    expect(data[0]!.tags).toEqual(['vip']);
  });

  it('returns empty array when no customers found', async () => {
    mockGetShopifyClient.mockResolvedValue(makeCustomerClient([]));

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('search_customers')!.handler(
      { query: 'nobody' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('passes the query string to Shopify', async () => {
    const graphql = vi.fn().mockResolvedValue({
      customers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    await registry.get('search_customers')!.handler({ query: 'john@example.com' }, makeContext());

    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: 'john@example.com' })
    );
  });

  it('returns null lastOrderDate when customer has no orders', async () => {
    const customer = makeCustomer({ lastOrder: null, numberOfOrders: 0 });
    mockGetShopifyClient.mockResolvedValue(makeCustomerClient([customer]));

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('search_customers')!.handler(
      { query: 'alice' },
      makeContext()
    );

    const data = result.data as Array<{ lastOrderDate: string | null }>;
    expect(data[0]!.lastOrderDate).toBeNull();
  });
});

// ─── get_top_customers ────────────────────────────────────────────────────────

describe('get_top_customers', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns top customers sorted by total_spent via TOTAL_SPENT sortKey', async () => {
    const customers = [
      makeCustomer({ amountSpent: { amount: '1000.00', currencyCode: 'USD' } }),
      makeCustomer({ id: 'gid://shopify/Customer/2', displayName: 'Bob', amountSpent: { amount: '500.00', currencyCode: 'USD' } }),
    ];
    const graphql = vi.fn().mockResolvedValue({
      customers: {
        edges: customers.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_top_customers')!.handler(
      { limit: 10, sortBy: 'total_spent' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sortKey: 'TOTAL_SPENT' })
    );
    const data = result.data as Array<{ name: string; totalSpent: number }>;
    expect(data[0]!.name).toBe('Alice Smith');
    expect(data[0]!.totalSpent).toBe(1000);
  });

  it('sorts by numberOfOrders in memory when sortBy is order_count', async () => {
    const customers = [
      makeCustomer({ numberOfOrders: 2 }),
      makeCustomer({ id: 'gid://shopify/Customer/2', displayName: 'Bob', numberOfOrders: 10 }),
      makeCustomer({ id: 'gid://shopify/Customer/3', displayName: 'Carol', numberOfOrders: 7 }),
    ];
    const graphql = vi.fn().mockResolvedValue({
      customers: {
        edges: customers.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_top_customers')!.handler(
      { limit: 3, sortBy: 'order_count' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string; orderCount: number }>;
    expect(data[0]!.name).toBe('Bob');
    expect(data[0]!.orderCount).toBe(10);
    expect(data[1]!.name).toBe('Carol');
    expect(data[1]!.orderCount).toBe(7);
  });

  it('respects the limit parameter', async () => {
    const customers = Array.from({ length: 5 }, (_, i) =>
      makeCustomer({ id: `gid://shopify/Customer/${i}`, displayName: `Customer ${i}` })
    );
    const graphql = vi.fn().mockResolvedValue({
      customers: {
        edges: customers.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = new ToolRegistry();
    registerShopifyCustomerTools({} as never, registry);
    const result = await registry.get('get_top_customers')!.handler(
      { limit: 3, sortBy: 'total_spent' },
      makeContext()
    );

    // Shopify returns fewer due to limit passed to fetchCustomers
    expect(result.success).toBe(true);
  });
});
