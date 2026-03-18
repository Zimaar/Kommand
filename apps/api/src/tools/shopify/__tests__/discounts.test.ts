import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerShopifyDiscountTools } from '../discounts.js';
import type { ShopifyClient } from '../client.js';
import type { ToolContext } from '@kommand/shared';
import { ToolRegistry } from '../../../core/tool-registry.js';

// ─── Module mock (hoisted) ────────────────────────────────────────────────────

const mockGetShopifyClient = vi.fn();

vi.mock('../index.js', () => ({
  getShopifyClient: (...args: unknown[]) => mockGetShopifyClient(...args),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    storeId: 'store-1',
    timezone: 'UTC',
    currency: 'USD',
    ...overrides,
  };
}

/** Build a DiscountCodeBasic node fixture for the list query */
function makeDiscountNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gid://shopify/DiscountCodeNode/1',
    codeDiscount: {
      __typename: 'DiscountCodeBasic',
      title: 'SUMMER20',
      status: 'ACTIVE',
      codes: { edges: [{ node: { code: 'SUMMER20', usageCount: 5 } }] },
      customerGets: {
        value: { __typename: 'DiscountPercentage', percentage: 0.2 },
      },
      startsAt: '2024-06-01T00:00:00Z',
      endsAt: '2024-08-31T23:59:59Z',
      usageLimit: 100,
      ...overrides,
    },
  };
}

function makeClient(
  graphqlImpl: (query: string, vars: unknown) => unknown = () => ({})
): ShopifyClient {
  return {
    graphql: vi.fn().mockImplementation(graphqlImpl),
    rest: vi.fn(),
  } as unknown as ShopifyClient;
}

function makeRegistry() {
  const registry = new ToolRegistry();
  registerShopifyDiscountTools({} as never, registry);
  return registry;
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe('registerShopifyDiscountTools', () => {
  it('registers all 3 tools', () => {
    const registry = makeRegistry();
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('list_active_discounts');
    expect(names).toContain('create_discount');
    expect(names).toContain('disable_discount');
  });

  it('list_active_discounts is tier 0', () => {
    const registry = makeRegistry();
    expect(registry.get('list_active_discounts')!.confirmationTier).toBe(0);
  });

  it('create_discount is tier 1', () => {
    const registry = makeRegistry();
    expect(registry.get('create_discount')!.confirmationTier).toBe(1);
  });

  it('disable_discount is tier 1', () => {
    const registry = makeRegistry();
    expect(registry.get('disable_discount')!.confirmationTier).toBe(1);
  });
});

// ─── list_active_discounts ────────────────────────────────────────────────────

describe('list_active_discounts', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns normalized percentage discount', async () => {
    const client = makeClient(() => ({
      codeDiscountNodes: {
        edges: [{ node: makeDiscountNode() }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('list_active_discounts')!.handler({}, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as Array<{
      code: string;
      type: string;
      value: number;
      usageCount: number;
      usageLimit: number | null;
      status: string;
    }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.code).toBe('SUMMER20');
    expect(data[0]!.type).toBe('percentage');
    expect(data[0]!.value).toBe(20);
    expect(data[0]!.usageCount).toBe(5);
    expect(data[0]!.usageLimit).toBe(100);
    expect(data[0]!.status).toBe('ACTIVE');
  });

  it('returns normalized fixed_amount discount', async () => {
    const node = makeDiscountNode({
      codes: { edges: [{ node: { code: 'SAVE10', usageCount: 2 } }] },
      customerGets: {
        value: {
          __typename: 'DiscountAmount',
          amount: { amount: '10.00', currencyCode: 'USD' },
        },
      },
    });
    const client = makeClient(() => ({
      codeDiscountNodes: {
        edges: [{ node }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('list_active_discounts')!.handler({}, makeContext());

    const data = result.data as Array<{ code: string; type: string; value: number }>;
    expect(data[0]!.type).toBe('fixed_amount');
    expect(data[0]!.value).toBe(10);
  });

  it('returns normalized free_shipping discount', async () => {
    const node = {
      id: 'gid://shopify/DiscountCodeNode/2',
      codeDiscount: {
        __typename: 'DiscountCodeFreeShipping',
        title: 'FREESHIP',
        status: 'ACTIVE',
        codes: { edges: [{ node: { code: 'FREESHIP', usageCount: 0 } }] },
        startsAt: '2024-01-01T00:00:00Z',
        endsAt: null,
      },
    };
    const client = makeClient(() => ({
      codeDiscountNodes: {
        edges: [{ node }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('list_active_discounts')!.handler({}, makeContext());

    const data = result.data as Array<{ type: string; value: null }>;
    expect(data[0]!.type).toBe('free_shipping');
    expect(data[0]!.value).toBeNull();
  });

  it('returns empty array when no active discounts', async () => {
    const client = makeClient(() => ({
      codeDiscountNodes: {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('list_active_discounts')!.handler({}, makeContext());

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('paginates until hasNextPage is false', async () => {
    let call = 0;
    const client = makeClient(() => {
      call++;
      if (call === 1) {
        return {
          codeDiscountNodes: {
            edges: [{ node: makeDiscountNode() }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        };
      }
      return {
        codeDiscountNodes: {
          edges: [{ node: makeDiscountNode({ title: 'FALL10' }) }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('list_active_discounts')!.handler({}, makeContext());

    expect(client.graphql).toHaveBeenCalledTimes(2);
    expect(client.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: 'cursor-1' })
    );
    const data = result.data as unknown[];
    expect(data).toHaveLength(2);
  });
});

// ─── create_discount ──────────────────────────────────────────────────────────

describe('create_discount', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('creates a percentage discount and returns success', async () => {
    const client = makeClient(() => ({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: 'gid://shopify/DiscountCodeNode/99',
          codeDiscount: {
            codes: { edges: [{ node: { code: 'SUMMER20' } }] },
            status: 'ACTIVE',
          },
        },
        userErrors: [],
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('create_discount')!.handler(
      { code: 'SUMMER20', type: 'percentage', value: 20 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { code: string; type: string; value: number; status: string };
    expect(data.code).toBe('SUMMER20');
    expect(data.type).toBe('percentage');
    expect(data.value).toBe(20);
    expect(data.status).toBe('ACTIVE');
    expect(result.display).toContain('SUMMER20');
    expect(result.display).toContain('20%');
  });

  it('uppercases the discount code', async () => {
    const graphql = vi.fn().mockResolvedValue({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: 'gid://shopify/DiscountCodeNode/99',
          codeDiscount: {
            codes: { edges: [{ node: { code: 'LOWER10' } }] },
            status: 'ACTIVE',
          },
        },
        userErrors: [],
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    await registry.get('create_discount')!.handler(
      { code: 'lower10', type: 'percentage', value: 10 },
      makeContext()
    );

    // Variables passed to graphql should include uppercased code
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        basicCodeDiscount: expect.objectContaining({
          codes: ['LOWER10'],
        }),
      })
    );
  });

  it('sends discountPercentage as fraction for percentage type', async () => {
    const graphql = vi.fn().mockResolvedValue({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: 'gid://shopify/DiscountCodeNode/99',
          codeDiscount: {
            codes: { edges: [{ node: { code: 'PCT25' } }] },
            status: 'ACTIVE',
          },
        },
        userErrors: [],
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    await registry.get('create_discount')!.handler(
      { code: 'PCT25', type: 'percentage', value: 25 },
      makeContext()
    );

    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        basicCodeDiscount: expect.objectContaining({
          customerGets: expect.objectContaining({
            value: { discountPercentage: 0.25 },
          }),
        }),
      })
    );
  });

  it('sends discountAmount for fixed_amount type', async () => {
    const graphql = vi.fn().mockResolvedValue({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: 'gid://shopify/DiscountCodeNode/99',
          codeDiscount: {
            codes: { edges: [{ node: { code: 'SAVE15' } }] },
            status: 'ACTIVE',
          },
        },
        userErrors: [],
      },
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    await registry.get('create_discount')!.handler(
      { code: 'SAVE15', type: 'fixed_amount', value: 15 },
      makeContext()
    );

    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        basicCodeDiscount: expect.objectContaining({
          customerGets: expect.objectContaining({
            value: { discountAmount: { amount: '15.00', appliesOnEachItem: false } },
          }),
        }),
      })
    );
  });

  it('returns error when Shopify returns userErrors', async () => {
    const client = makeClient(() => ({
      discountCodeBasicCreate: {
        codeDiscountNode: null,
        userErrors: [{ field: ['code'], message: 'Discount code has already been taken' }],
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('create_discount')!.handler(
      { code: 'SUMMER20', type: 'percentage', value: 20 },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('already been taken');
  });

  it('includes endsAt in display when provided', async () => {
    const client = makeClient(() => ({
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: 'gid://shopify/DiscountCodeNode/99',
          codeDiscount: {
            codes: { edges: [{ node: { code: 'EXPIRING' } }] },
            status: 'ACTIVE',
          },
        },
        userErrors: [],
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('create_discount')!.handler(
      { code: 'EXPIRING', type: 'percentage', value: 10, ends_at: '2024-12-31T23:59:59Z' },
      makeContext()
    );

    expect(result.display).toContain('2024-12-31');
  });
});

// ─── disable_discount ─────────────────────────────────────────────────────────

describe('disable_discount', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('deactivates an active discount', async () => {
    let call = 0;
    const graphql = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        // codeDiscountNodeByCode lookup
        return Promise.resolve({
          codeDiscountNodeByCode: {
            id: 'gid://shopify/DiscountCodeNode/1',
            codeDiscount: { __typename: 'DiscountCodeBasic', title: 'SUMMER20', status: 'ACTIVE' },
          },
        });
      }
      // discountCodeDeactivate mutation
      return Promise.resolve({
        discountCodeDeactivate: {
          codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' },
          userErrors: [],
        },
      });
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('disable_discount')!.handler(
      { code: 'SUMMER20' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { code: string; previousStatus: string };
    expect(data.code).toBe('SUMMER20');
    expect(data.previousStatus).toBe('ACTIVE');
    expect(result.display).toContain('SUMMER20');
    expect(result.display).toContain('deactivated');
  });

  it('returns error when discount code not found', async () => {
    const client = makeClient(() => ({
      codeDiscountNodeByCode: null,
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('disable_discount')!.handler(
      { code: 'NOTEXIST' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when discount is already expired', async () => {
    const client = makeClient(() => ({
      codeDiscountNodeByCode: {
        id: 'gid://shopify/DiscountCodeNode/1',
        codeDiscount: { __typename: 'DiscountCodeBasic', title: 'OLD', status: 'EXPIRED' },
      },
    }));
    mockGetShopifyClient.mockResolvedValue(client);

    const registry = makeRegistry();
    const result = await registry.get('disable_discount')!.handler(
      { code: 'OLD' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('already expired');
  });

  it('returns error when Shopify deactivate returns userErrors', async () => {
    let call = 0;
    const graphql = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          codeDiscountNodeByCode: {
            id: 'gid://shopify/DiscountCodeNode/1',
            codeDiscount: { __typename: 'DiscountCodeBasic', title: 'SUMMER20', status: 'ACTIVE' },
          },
        });
      }
      return Promise.resolve({
        discountCodeDeactivate: {
          codeDiscountNode: null,
          userErrors: [{ field: ['id'], message: 'Discount not found' }],
        },
      });
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    const result = await registry.get('disable_discount')!.handler(
      { code: 'SUMMER20' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to disable');
  });

  it('uppercases the code when looking up', async () => {
    let call = 0;
    const graphql = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          codeDiscountNodeByCode: {
            id: 'gid://shopify/DiscountCodeNode/1',
            codeDiscount: { __typename: 'DiscountCodeBasic', title: 'LOWER20', status: 'ACTIVE' },
          },
        });
      }
      return Promise.resolve({
        discountCodeDeactivate: {
          codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' },
          userErrors: [],
        },
      });
    });
    mockGetShopifyClient.mockResolvedValue({ graphql, rest: vi.fn() } as unknown as ShopifyClient);

    const registry = makeRegistry();
    await registry.get('disable_discount')!.handler({ code: 'lower20' }, makeContext());

    expect(graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ code: 'LOWER20' })
    );
  });
});
