import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';
import type { ShopifyClient } from './client.js';
import { getDateRange } from './orders-read.js';
import { round2 } from './math.js';

// ─── GraphQL types ────────────────────────────────────────────────────────────

export interface CustomerNode {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  numberOfOrders: number;
  amountSpent: { amount: string; currencyCode: string };
  createdAt: string;
  tags: string[];
  lastOrder: { createdAt: string } | null;
}

interface CustomersResponse {
  customers: {
    edges: Array<{ node: CustomerNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// Slim order used only to compute returning customers + AOV per period
export interface CustomerOrderSlim {
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: { id: string; createdAt: string } | null;
}

interface SlimOrdersResponse {
  orders: {
    edges: Array<{ node: CustomerOrderSlim }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const CUSTOMERS_GQL = `
  query GetCustomers($query: String!, $first: Int!, $after: String, $sortKey: CustomerSortKeys) {
    customers(first: $first, query: $query, after: $after, sortKey: $sortKey, reverse: true) {
      edges {
        node {
          id
          displayName
          email
          phone
          numberOfOrders
          amountSpent { amount currencyCode }
          createdAt
          tags
          lastOrder { createdAt }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SLIM_ORDERS_GQL = `
  query GetSlimOrders($query: String!, $first: Int!, $after: String) {
    orders(first: $first, query: $query, after: $after) {
      edges {
        node {
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id createdAt }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Fetch helpers ────────────────────────────────────────────────────────────

export async function fetchCustomers(
  client: ShopifyClient,
  queryFilter: string,
  limit = 250,
  sortKey = 'RELEVANCE'
): Promise<CustomerNode[]> {
  const all: CustomerNode[] = [];
  let after: string | null = null;
  let remaining = limit;

  do {
    const batch = Math.min(remaining, 250);
    const data = await client.graphql<CustomersResponse>(CUSTOMERS_GQL, {
      query: queryFilter,
      first: batch,
      after,
      sortKey,
    });
    const edges = data.customers.edges;
    all.push(...edges.map((e) => e.node));
    remaining -= edges.length;
    if (!data.customers.pageInfo.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
  } while (remaining > 0);

  return all;
}

export async function fetchSlimOrders(
  client: ShopifyClient,
  queryFilter: string,
  limit = 500
): Promise<CustomerOrderSlim[]> {
  const all: CustomerOrderSlim[] = [];
  let after: string | null = null;
  let remaining = limit;

  do {
    const batch = Math.min(remaining, 250);
    const data = await client.graphql<SlimOrdersResponse>(SLIM_ORDERS_GQL, {
      query: queryFilter,
      first: batch,
      after,
    });
    const edges = data.orders.edges;
    all.push(...edges.map((e) => e.node));
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

const GetCustomerSummaryInput = z.object({
  period: PeriodEnum.default('this_month'),
});

const SearchCustomersInput = z.object({
  query: z.string().min(1),
});

const GetTopCustomersInput = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  sortBy: z.enum(['total_spent', 'order_count']).default('total_spent'),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeGetCustomerSummary(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetCustomerSummaryInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const { start, end } = getDateRange(input.period, context.timezone);

    // Fetch in parallel: total customers (REST count), new customers (REST count),
    // orders in period (for returning + AOV), top 5 customers by total spent
    const [totalData, newData, periodOrders, topCustomers] = await Promise.all([
      client.rest<{ count: number }>('GET', '/customers/count.json'),
      client.rest<{ count: number }>(
        'GET',
        `/customers/count.json?created_at_min=${encodeURIComponent(start)}&created_at_max=${encodeURIComponent(end)}`
      ),
      fetchSlimOrders(client, `created_at:>='${start}' created_at:<='${end}'`, 500),
      fetchCustomers(client, '', 5, 'TOTAL_SPENT'),
    ]);

    // Returning = placed an order in the period but was created before the period
    const returningIds = new Set<string>();
    let totalRevenue = 0;
    let currency = context.currency;

    for (const order of periodOrders) {
      totalRevenue += parseFloat(order.totalPriceSet.shopMoney.amount);
      currency = order.totalPriceSet.shopMoney.currencyCode;
      if (order.customer && order.customer.createdAt < start) {
        returningIds.add(order.customer.id);
      }
    }

    const orderCount = periodOrders.length;

    return {
      success: true,
      data: {
        totalCustomers: totalData.count,
        newCustomers: newData.count,
        returningCustomers: returningIds.size,
        averageOrderValue: orderCount > 0 ? round2(totalRevenue / orderCount) : 0,
        currency,
        period: input.period,
        topCustomers: topCustomers.map((c) => ({
          name: c.displayName,
          email: c.email,
          totalSpent: round2(parseFloat(c.amountSpent.amount)),
          orderCount: c.numberOfOrders,
        })),
      },
    };
  };
}

function makeSearchCustomers(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = SearchCustomersInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const customers = await fetchCustomers(client, input.query, 20);

    if (customers.length === 0) {
      return { success: true, data: [] };
    }

    const data = customers.map((c) => ({
      name: c.displayName,
      email: c.email,
      phone: c.phone,
      totalSpent: round2(parseFloat(c.amountSpent.amount)),
      orderCount: c.numberOfOrders,
      lastOrderDate: c.lastOrder?.createdAt ?? null,
      tags: c.tags,
    }));

    return { success: true, data };
  };
}

function makeGetTopCustomers(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetTopCustomersInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    let customers: CustomerNode[];

    if (input.sortBy === 'total_spent') {
      customers = await fetchCustomers(client, '', input.limit, 'TOTAL_SPENT');
    } else {
      // order_count has no direct GraphQL sort key — fetch more, sort in memory
      const fetched = await fetchCustomers(client, '', Math.max(input.limit * 5, 50), 'RELEVANCE');
      fetched.sort((a, b) => b.numberOfOrders - a.numberOfOrders);
      customers = fetched.slice(0, input.limit);
    }

    const data = customers.map((c) => ({
      name: c.displayName,
      email: c.email,
      phone: c.phone,
      totalSpent: round2(parseFloat(c.amountSpent.amount)),
      orderCount: c.numberOfOrders,
      lastOrderDate: c.lastOrder?.createdAt ?? null,
      tags: c.tags,
    }));

    return { success: true, data };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

const PERIOD_SCHEMA_PROP = {
  type: 'string',
  enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days'],
};

export function registerShopifyCustomerTools(db: DB, registry: ToolRegistry): void {
  const tools: Parameters<ToolRegistry['register']>[0][] = [
    {
      name: 'get_customer_summary',
      description:
        'Get customer stats for a time period: total customers, new customers, returning customers, average order value, and top 5 customers by spend. Use when the merchant asks about their customers, customer growth, or who their best customers are.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: { period: { ...PERIOD_SCHEMA_PROP, default: 'this_month' } },
        required: [],
      },
      handler: makeGetCustomerSummary(db),
    },
    {
      name: 'search_customers',
      description:
        'Search for customers by name, email, or phone number. Use when the merchant asks about a specific customer or wants to look someone up. Returns matching customers with their spend and order history.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          query: {
            type: 'string',
            description: 'Customer name, email address, or phone number to search for',
          },
        },
        required: ['query'],
      },
      handler: makeSearchCustomers(db),
    },
    {
      name: 'get_top_customers',
      description:
        'Get the top customers ranked by total lifetime spend or order count. Use when the merchant asks for their best or most loyal customers, or wants a VIP customer list.',
      platform: 'shopify',
      confirmationTier: 0,
      inputSchema: {
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 20, default: 10 },
          sortBy: {
            type: 'string',
            enum: ['total_spent', 'order_count'],
            default: 'total_spent',
          },
        },
        required: [],
      },
      handler: makeGetTopCustomers(db),
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}
