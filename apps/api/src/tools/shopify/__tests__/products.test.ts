import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fuzzyMatch, registerShopifyProductTools } from '../products.js';
import { ToolRegistry } from '../../../core/tool-registry.js';
import { ToolDispatcher } from '../../../core/tool-dispatcher.js';
import type { ShopifyClient } from '../client.js';
import type { ToolContext } from '@kommand/shared';
import type { CommandStore } from '../../../core/tool-dispatcher.js';
import type { ConfirmationEngine, PendingConfirmationRecord } from '../../../core/confirmation-engine.js';

// ─── Module mock (hoisted) ────────────────────────────────────────────────────

const mockGetShopifyClient = vi.fn();

vi.mock('../index.js', () => ({
  getShopifyClient: (...args: unknown[]) => mockGetShopifyClient(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    storeId: 'store-1',
    timezone: 'UTC',
    currency: 'USD',
    ...overrides,
  };
}

function makeVariant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'gid://shopify/ProductVariant/1',
    title: 'Default Title',
    price: '29.99',
    inventoryQuantity: 50,
    inventoryItem: { id: 'gid://shopify/InventoryItem/1' },
    ...overrides,
  };
}

function makeProduct(
  title: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  return {
    id: 'gid://shopify/Product/1',
    title,
    status: 'ACTIVE',
    productType: 'T-Shirts',
    createdAt: '2024-01-01T00:00:00Z',
    variants: {
      edges: [{ node: makeVariant() }],
    },
    ...overrides,
  };
}

function makeProductsPage(
  products: ReturnType<typeof makeProduct>[],
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    products: {
      edges: products.map((node) => ({ node })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

function makeClient(
  graphqlImpl: (query: string, variables?: unknown) => Promise<unknown>
): ShopifyClient {
  return {
    graphql: vi.fn().mockImplementation(graphqlImpl),
    rest: vi.fn(),
  } as unknown as ShopifyClient;
}

function makeLocationsResponse(name = 'Main Warehouse') {
  return {
    locations: {
      edges: [{ node: { id: 'gid://shopify/Location/1', name } }],
    },
  };
}

// ─── In-memory infra stubs ────────────────────────────────────────────────────

function makeCommandStore(): CommandStore {
  let seq = 0;
  return {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async () => ({ id: `cmd-${++seq}` })),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfirmationEngine(): ConfirmationEngine {
  const records = new Map<string, PendingConfirmationRecord>();
  let seq = 0;
  return {
    create: vi.fn().mockImplementation(async (opts) => {
      const record: PendingConfirmationRecord = {
        id: `conf-${++seq}`,
        userId: opts.userId,
        commandId: opts.commandId,
        toolName: opts.toolName,
        params: opts.params,
        context: opts.context,
        promptText: opts.promptText,
        tier: opts.tier ?? 1,
        expiresAt: new Date(Date.now() + 600_000),
      };
      records.set(record.id, record);
      return record;
    }),
    get: vi.fn().mockImplementation(async (id: string) => records.get(id) ?? null),
    complete: vi.fn().mockResolvedValue(undefined),
    handleResponse: vi.fn().mockResolvedValue({ handled: false }),
    cleanupExpired: vi.fn().mockResolvedValue(0),
    getPromptText: vi.fn().mockReturnValue('Confirm?'),
  };
}

// ─── fuzzyMatch ────────────────────────────────────────────────────────────────

describe('fuzzyMatch', () => {
  it('matches exact substring (case-insensitive)', () => {
    expect(fuzzyMatch('white tee', 'Classic White Tee - Cotton')).toBe(true);
  });

  it('matches when query is substring of target', () => {
    expect(fuzzyMatch('tee', 'Classic White Tee - Cotton')).toBe(true);
  });

  it('matches when all words appear anywhere in target', () => {
    expect(fuzzyMatch('cotton classic', 'Classic White Tee - Cotton')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('WHITE TEE', 'classic white tee')).toBe(true);
  });

  it('returns false when query word is not in target', () => {
    expect(fuzzyMatch('blue tee', 'Classic White Tee - Cotton')).toBe(false);
  });

  it('returns false for completely unrelated string', () => {
    expect(fuzzyMatch('hoodie', 'Classic White Tee - Cotton')).toBe(false);
  });

  it('matches single-word query', () => {
    expect(fuzzyMatch('cotton', 'Classic White Tee - Cotton')).toBe(true);
  });

  it('handles leading/trailing spaces in query', () => {
    expect(fuzzyMatch('  white tee  ', 'Classic White Tee - Cotton')).toBe(true);
  });

  it('handles numeric product codes in name', () => {
    expect(fuzzyMatch('tee 2024', 'Summer Tee 2024 Edition')).toBe(true);
  });
});

// ─── Tool registration ─────────────────────────────────────────────────────────

describe('registerShopifyProductTools', () => {
  it('registers all 4 product tools', () => {
    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('get_products');
    expect(names).toContain('get_product_inventory');
    expect(names).toContain('update_product_price');
    expect(names).toContain('update_inventory');
  });

  it('read tools are tier 0', () => {
    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    expect(registry.get('get_products')!.confirmationTier).toBe(0);
    expect(registry.get('get_product_inventory')!.confirmationTier).toBe(0);
  });

  it('update_product_price is tier 2', () => {
    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    expect(registry.get('update_product_price')!.confirmationTier).toBe(2);
  });

  it('update_inventory is tier 1', () => {
    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    expect(registry.get('update_inventory')!.confirmationTier).toBe(1);
  });
});

// ─── ToolDispatcher confirmation flow ─────────────────────────────────────────

describe('write tool confirmation via ToolDispatcher', () => {
  function makeDispatcher() {
    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const commandStore = makeCommandStore();
    const confirmationEngine = makeConfirmationEngine();
    const dispatcher = new ToolDispatcher(registry, confirmationEngine, commandStore);
    return { dispatcher, commandStore, confirmationEngine };
  }

  beforeEach(() => mockGetShopifyClient.mockReset());

  it('update_product_price (tier 2) returns requiresConfirmation without calling handler', async () => {
    const { dispatcher, confirmationEngine } = makeDispatcher();

    const result = await dispatcher.dispatch(
      'update_product_price',
      { product_name: 'white tee', new_price: 39.99 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(2);
    expect(confirmationEngine.create).toHaveBeenCalledOnce();
    expect(mockGetShopifyClient).not.toHaveBeenCalled();
  });

  it('update_inventory (tier 1) returns requiresConfirmation without calling handler', async () => {
    const { dispatcher } = makeDispatcher();

    const result = await dispatcher.dispatch(
      'update_inventory',
      { product_name: 'white tee', adjustment: 10 },
      makeContext()
    );

    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(1);
    expect(mockGetShopifyClient).not.toHaveBeenCalled();
  });
});

// ─── get_products handler ─────────────────────────────────────────────────────

describe('get_products handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns formatted product list', async () => {
    const products = [
      makeProduct('Classic White Tee'),
      makeProduct('Blue Hoodie', {
        variants: {
          edges: [{ node: makeVariant({ price: '49.99', inventoryQuantity: 20 }) }],
        },
      }),
    ];
    const graphql = vi.fn().mockResolvedValue(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_products')!.handler({}, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as Array<{ title: string; price: string; inventory: number }>;
    expect(data).toHaveLength(2);
    expect(data[0]!.title).toBe('Classic White Tee');
    expect(data[0]!.price).toBe('29.99');
    expect(data[0]!.inventory).toBe(50);
  });

  it('applies fuzzy filter client-side when search provided', async () => {
    const products = [
      makeProduct('Classic White Tee'),
      makeProduct('Blue Denim Jeans'), // should not match "tee"
    ];
    const graphql = vi.fn().mockResolvedValue(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_products')!.handler(
      { search: 'white tee' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{ title: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.title).toBe('Classic White Tee');
  });

  it('respects limit', async () => {
    const products = Array.from({ length: 5 }, (_, i) => makeProduct(`Product ${i + 1}`));
    const graphql = vi.fn().mockResolvedValue(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_products')!.handler({ limit: 3 }, makeContext());

    const data = result.data as Array<{ title: string }>;
    expect(data).toHaveLength(3);
  });

  it('includes variant breakdown in result', async () => {
    const product = makeProduct('Multi-Size Shirt', {
      variants: {
        edges: [
          { node: makeVariant({ id: 'v1', title: 'Small', price: '25.00', inventoryQuantity: 10 }) },
          { node: makeVariant({ id: 'v2', title: 'Large', price: '27.00', inventoryQuantity: 5 }) },
        ],
      },
    });
    const graphql = vi.fn().mockResolvedValue(makeProductsPage([product]));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_products')!.handler({}, makeContext());

    const data = result.data as Array<{
      variantCount: number;
      variants: Array<{ title: string }>;
      price: string;
      inventory: number;
    }>;
    expect(data[0]!.variantCount).toBe(2);
    expect(data[0]!.variants).toHaveLength(2);
    expect(data[0]!.inventory).toBe(15); // 10 + 5
    expect(data[0]!.price).toBe('25.00'); // min price
  });
});

// ─── get_product_inventory handler ───────────────────────────────────────────

describe('get_product_inventory handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns inventory for specific product', async () => {
    const product = makeProduct('Classic White Tee', {
      variants: {
        edges: [
          { node: makeVariant({ title: 'Small', inventoryQuantity: 10 }) },
          { node: makeVariant({ id: 'v2', title: 'Large', inventoryQuantity: 3 }) },
        ],
      },
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeLocationsResponse('Main Store'))
      .mockResolvedValueOnce(makeProductsPage([product]));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_product_inventory')!.handler(
      { product_name: 'white tee' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as Array<{
      productTitle: string;
      variant: string;
      available: number;
      location: string;
    }>;
    expect(data).toHaveLength(2);
    expect(data[0]!.productTitle).toBe('Classic White Tee');
    expect(data[0]!.location).toBe('Main Store');
    expect(data.map((d) => d.variant)).toContain('Small');
    expect(data.map((d) => d.variant)).toContain('Large');
  });

  it('returns not found when no products match', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeLocationsResponse())
      .mockResolvedValueOnce(makeProductsPage([]));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_product_inventory')!.handler(
      { product_name: 'invisible product' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('invisible product');
  });

  it('returns low-stock items when no product_name given', async () => {
    const products = [
      makeProduct('Low Stock Item', {
        variants: {
          edges: [{ node: makeVariant({ inventoryQuantity: 3 }) }],
        },
      }),
      makeProduct('Well Stocked Item', {
        variants: {
          edges: [{ node: makeVariant({ inventoryQuantity: 100 }) }],
        },
      }),
    ];
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeLocationsResponse('Main Store'))
      .mockResolvedValueOnce(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_product_inventory')!.handler({}, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as Array<{ productTitle: string; available: number }>;
    // Only the one with < 10 units should be returned
    expect(data).toHaveLength(1);
    expect(data[0]!.productTitle).toBe('Low Stock Item');
    expect(data[0]!.available).toBe(3);
    expect(result.display).toContain('1 variant');
  });

  it('returns all-stocked message when no low-stock items', async () => {
    const products = [
      makeProduct('Well Stocked', {
        variants: { edges: [{ node: makeVariant({ inventoryQuantity: 50 }) }] },
      }),
    ];
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeLocationsResponse())
      .mockResolvedValueOnce(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('get_product_inventory')!.handler({}, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as [];
    expect(data).toHaveLength(0);
    expect(result.display).toContain('sufficient stock');
  });
});

// ─── update_product_price handler ────────────────────────────────────────────

describe('update_product_price handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns error when product not found', async () => {
    const graphql = vi.fn().mockResolvedValue(makeProductsPage([]));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_product_price')!.handler(
      { product_name: 'nonexistent', new_price: 99 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('returns requiresSelection when multiple products match', async () => {
    const products = [
      makeProduct('White Tee - Small'),
      makeProduct('White Tee - Large'),
    ];
    const graphql = vi.fn().mockResolvedValue(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_product_price')!.handler(
      { product_name: 'white tee', new_price: 39.99 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { requiresSelection: boolean; matches: Array<{ title: string }> };
    expect(data.requiresSelection).toBe(true);
    expect(data.matches).toHaveLength(2);
    expect(data.matches.map((m) => m.title)).toContain('White Tee - Small');
  });

  it('updates price for single matched product', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce({
        productVariantUpdate: {
          productVariant: {
            id: 'gid://shopify/ProductVariant/1',
            title: 'Default Title',
            price: '39.99',
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_product_price')!.handler(
      { product_name: 'white tee', new_price: 39.99 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { oldPrice: number; newPrice: number; productTitle: string };
    expect(data.oldPrice).toBe(29.99);
    expect(data.newPrice).toBe(39.99);
    expect(data.productTitle).toBe('Classic White Tee');
    expect(result.display).toContain('29.99');
    expect(result.display).toContain('39.99');
  });

  it('selects variant by fuzzy match when variant hint provided', async () => {
    const product = makeProduct('Multi-Variant Shirt', {
      variants: {
        edges: [
          { node: makeVariant({ id: 'v-small', title: 'Small', price: '25.00' }) },
          { node: makeVariant({ id: 'v-large', title: 'Large', price: '27.00' }) },
        ],
      },
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce({
        productVariantUpdate: {
          productVariant: { id: 'v-large', title: 'Large', price: '35.00' },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    await registry.get('update_product_price')!.handler(
      { product_name: 'shirt', new_price: 35, variant: 'large' },
      makeContext()
    );

    // The mutation should have been called with the Large variant's ID
    const mutationCall = graphql.mock.calls[1] as [
      string,
      { input: { id: string; price: string } },
    ];
    expect(mutationCall[1].input.id).toBe('v-large');
    expect(mutationCall[1].input.price).toBe('35.00');
  });

  it('surfaces Shopify userErrors on price update', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce({
        productVariantUpdate: {
          productVariant: null,
          userErrors: [{ field: 'price', message: 'Price is not a valid decimal' }],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    // Use a valid price for Zod; the mock simulates a Shopify API-level rejection
    const result = await registry.get('update_product_price')!.handler(
      { product_name: 'white tee', new_price: 0.001 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Price is not a valid decimal');
  });
});

// ─── update_inventory handler — adjustment calculation ───────────────────────

describe('update_inventory handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  function setupGraphql(
    product: ReturnType<typeof makeProduct>,
    adjustmentResult: { quantityAfterChange: number }
  ) {
    return vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product])) // fetchProducts
      .mockResolvedValueOnce(makeLocationsResponse('Main Warehouse')) // locations
      .mockResolvedValueOnce({
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: {
            id: 'gid://shopify/InventoryAdjustmentGroup/1',
            reason: 'correction',
            changes: [
              {
                name: 'available',
                delta: adjustmentResult.quantityAfterChange - 50,
                quantityAfterChange: adjustmentResult.quantityAfterChange,
                location: { name: 'Main Warehouse' },
              },
            ],
          },
          userErrors: [],
        },
      });
  }

  it('calculates new total correctly for positive adjustment', async () => {
    const product = makeProduct('Classic White Tee'); // starts at 50
    const graphql = setupGraphql(product, { quantityAfterChange: 60 });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 10, reason: 'received' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      previousQuantity: number;
      adjustment: number;
      newQuantity: number;
    };
    expect(data.previousQuantity).toBe(50);
    expect(data.adjustment).toBe(10);
    expect(data.newQuantity).toBe(60);
    expect(result.display).toContain('+10');
    expect(result.display).toContain('60');
  });

  it('calculates new total correctly for negative adjustment (removal)', async () => {
    const product = makeProduct('Classic White Tee'); // starts at 50
    const graphql = setupGraphql(product, { quantityAfterChange: 45 });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: -5, reason: 'damaged' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { previousQuantity: number; adjustment: number; newQuantity: number };
    expect(data.previousQuantity).toBe(50);
    expect(data.adjustment).toBe(-5);
    expect(data.newQuantity).toBe(45);
    // Display should show -5 (not +-5)
    expect(result.display).toContain('-5');
    expect(result.display).not.toContain('+-5');
  });

  it('maps reason string to Shopify enum', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = setupGraphql(product, { quantityAfterChange: 60 });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 10, reason: 'returned' },
      makeContext()
    );

    const adjustCall = graphql.mock.calls[2] as [
      string,
      { input: { reason: string } },
    ];
    expect(adjustCall[1].input.reason).toBe('return_restock');
  });

  it('defaults to "correction" for unknown reason', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = setupGraphql(product, { quantityAfterChange: 55 });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 5 },
      makeContext()
    );

    const adjustCall = graphql.mock.calls[2] as [
      string,
      { input: { reason: string } },
    ];
    expect(adjustCall[1].input.reason).toBe('correction');
  });

  it('returns requiresSelection when multiple products match', async () => {
    const products = [
      makeProduct('White Tee - Small'),
      makeProduct('White Tee - Large'),
    ];
    const graphql = vi.fn().mockResolvedValue(makeProductsPage(products));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 5 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { requiresSelection: boolean; matches: Array<{ title: string }> };
    expect(data.requiresSelection).toBe(true);
    expect(data.matches).toHaveLength(2);
    expect(data.matches.map((m) => m.title)).toContain('White Tee - Small');
    // Handler must NOT have called the mutation (graphql called only once for fetchProducts)
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('returns error when no product matches', async () => {
    const graphql = vi.fn().mockResolvedValue(makeProductsPage([]));
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'ghost product', adjustment: 10 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('ghost product');
  });

  it('returns error when no location found', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce({ locations: { edges: [] } }); // no locations
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 5 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('location');
  });

  it('surfaces Shopify userErrors on inventory adjustment', async () => {
    const product = makeProduct('Classic White Tee');
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce(makeLocationsResponse())
      .mockResolvedValueOnce({
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [{ field: 'delta', message: 'Adjustment would result in negative stock', code: 'INVALID' }],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    const result = await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: -999 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Adjustment would result in negative stock');
  });

  it('passes the correct inventoryItemId and locationId to the mutation', async () => {
    const product = makeProduct('Classic White Tee', {
      variants: {
        edges: [
          {
            node: makeVariant({
              id: 'gid://shopify/ProductVariant/42',
              inventoryItem: { id: 'gid://shopify/InventoryItem/99' },
            }),
          },
        ],
      },
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(makeProductsPage([product]))
      .mockResolvedValueOnce({
        locations: {
          edges: [{ node: { id: 'gid://shopify/Location/7', name: 'Warehouse A' } }],
        },
      })
      .mockResolvedValueOnce({
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: {
            id: 'adj-1',
            reason: 'correction',
            changes: [{ name: 'available', delta: 5, quantityAfterChange: 55, location: { name: 'Warehouse A' } }],
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyProductTools({} as never, registry);
    await registry.get('update_inventory')!.handler(
      { product_name: 'white tee', adjustment: 5 },
      makeContext()
    );

    const adjustCall = graphql.mock.calls[2] as [
      string,
      {
        input: {
          changes: Array<{ inventoryItemId: string; locationId: string; delta: number }>;
        };
      },
    ];
    expect(adjustCall[1].input.changes[0]!.inventoryItemId).toBe('gid://shopify/InventoryItem/99');
    expect(adjustCall[1].input.changes[0]!.locationId).toBe('gid://shopify/Location/7');
    expect(adjustCall[1].input.changes[0]!.delta).toBe(5);
  });
});
