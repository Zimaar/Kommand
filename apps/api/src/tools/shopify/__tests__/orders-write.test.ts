import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerShopifyOrderWriteTools } from '../orders-write.js';
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

/** Full order fixture returned by fetchOrderForWrite */
function makeOrderWrite(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    cancelledAt: null,
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    customer: { displayName: 'Alice Smith' },
    email: 'alice@example.com',
    totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
    transactions: [
      {
        id: 'gid://shopify/Transaction/101',
        kind: 'SALE',
        status: 'SUCCESS',
        amountSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
      },
    ],
    lineItems: {
      edges: [
        {
          node: {
            id: 'gid://shopify/LineItem/201',
            quantity: 2,
            refundableQuantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
          },
        },
      ],
    },
    fulfillmentOrders: {
      edges: [
        {
          node: {
            id: 'gid://shopify/FulfillmentOrder/301',
            status: 'OPEN',
            lineItems: {
              edges: [{ node: { id: 'gid://shopify/FulfillmentOrderLineItem/401', remainingQuantity: 2 } }],
            },
          },
        },
      ],
    },
    fulfillments: [],
    ...overrides,
  };
}

/** Build a ShopifyClient mock where graphql is a jest.fn() you can chain */
function makeClient(
  graphqlImpl?: (query: string, variables?: unknown) => Promise<unknown>
): ShopifyClient {
  return {
    graphql: vi.fn().mockImplementation(graphqlImpl ?? (() => Promise.resolve({}))),
    rest: vi.fn(),
  } as unknown as ShopifyClient;
}

// ─── In-memory CommandStore ────────────────────────────────────────────────────

function makeCommandStore(): CommandStore {
  const store = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (opts) => {
      const id = `cmd-${++seq}`;
      store.set(id, { id, ...opts });
      return { id };
    }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── In-memory ConfirmationEngine ─────────────────────────────────────────────

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
    getPromptText: vi.fn().mockReturnValue('Confirm action?'),
  };
}

// ─── Registration tests ────────────────────────────────────────────────────────

describe('registerShopifyOrderWriteTools', () => {
  it('registers all 4 write tools', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const names = registry.getAll().map((t) => t.name);
    expect(names).toContain('refund_order');
    expect(names).toContain('cancel_order');
    expect(names).toContain('fulfill_order');
    expect(names).toContain('update_tracking');
  });

  it('refund_order and cancel_order are tier 2', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    expect(registry.get('refund_order')!.confirmationTier).toBe(2);
    expect(registry.get('cancel_order')!.confirmationTier).toBe(2);
  });

  it('fulfill_order and update_tracking are tier 1', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    expect(registry.get('fulfill_order')!.confirmationTier).toBe(1);
    expect(registry.get('update_tracking')!.confirmationTier).toBe(1);
  });

  it('all write tools are platform "shopify"', () => {
    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    registry.getAll().forEach((tool) => {
      expect(tool.platform).toBe('shopify');
    });
  });
});

// ─── ToolDispatcher — confirmation flow ────────────────────────────────────────

describe('ToolDispatcher confirmation flow for write tools', () => {
  function makeDispatcher() {
    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const commandStore = makeCommandStore();
    const confirmationEngine = makeConfirmationEngine();
    const dispatcher = new ToolDispatcher(registry, confirmationEngine, commandStore);
    return { dispatcher, commandStore, confirmationEngine };
  }

  it('tier-2 tool (refund_order) returns requiresConfirmation without calling handler', async () => {
    const { dispatcher, confirmationEngine } = makeDispatcher();
    // graphql should NOT be called — dispatcher halts at confirmation
    mockGetShopifyClient.mockReset();

    const result = await dispatcher.dispatch(
      'refund_order',
      { order_identifier: '#1001' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(2);
    expect(confirmationEngine.create).toHaveBeenCalledOnce();
    // getShopifyClient was never called (handler not executed)
    expect(mockGetShopifyClient).not.toHaveBeenCalled();
  });

  it('tier-2 tool (cancel_order) returns requiresConfirmation', async () => {
    const { dispatcher } = makeDispatcher();
    mockGetShopifyClient.mockReset();

    const result = await dispatcher.dispatch(
      'cancel_order',
      { order_identifier: '#1001' },
      makeContext()
    );

    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(2);
  });

  it('tier-1 tool (fulfill_order) returns requiresConfirmation', async () => {
    const { dispatcher } = makeDispatcher();
    mockGetShopifyClient.mockReset();

    const result = await dispatcher.dispatch(
      'fulfill_order',
      { order_identifier: '#1001' },
      makeContext()
    );

    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(1);
  });

  it('tier-1 tool (update_tracking) returns requiresConfirmation', async () => {
    const { dispatcher } = makeDispatcher();
    mockGetShopifyClient.mockReset();

    const result = await dispatcher.dispatch(
      'update_tracking',
      { order_identifier: '#1001', tracking_number: '1Z999' },
      makeContext()
    );

    const data = result.data as { requiresConfirmation: boolean; tier: number };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.tier).toBe(1);
  });

  it('executeConfirmed calls the handler after confirmation', async () => {
    const { dispatcher, confirmationEngine } = makeDispatcher();

    // Setup: first dispatch creates a pending confirmation
    const pendingResult = await dispatcher.dispatch(
      'fulfill_order',
      { order_identifier: '#1001', tracking_number: '1Z999' },
      makeContext()
    );

    const { confirmationId } = pendingResult.data as {
      confirmationId: string;
      requiresConfirmation: boolean;
    };

    // Now mock the client for the actual execution
    const graphql = vi
      .fn()
      // fetchOrderForWrite call
      .mockResolvedValueOnce({
        orders: {
          edges: [{ node: makeOrderWrite() }],
        },
      })
      // fulfillmentCreateV2 call
      .mockResolvedValueOnce({
        fulfillmentCreateV2: {
          fulfillment: {
            id: 'gid://shopify/Fulfillment/501',
            status: 'SUCCESS',
            trackingInfo: [{ number: '1Z999', company: null, url: null }],
          },
          userErrors: [],
        },
      });

    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const executeResult = await dispatcher.executeConfirmed(confirmationId, makeContext());
    expect(executeResult.success).toBe(true);
    const data = executeResult.data as { orderNumber: string; trackingNumber: string };
    expect(data.orderNumber).toBe('#1001');
    expect(data.trackingNumber).toBe('1Z999');
    expect(confirmationEngine.complete).toHaveBeenCalledWith(confirmationId);
  });
});

// ─── refund_order handler ──────────────────────────────────────────────────────

describe('refund_order handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns error if order not found', async () => {
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('refund_order')!.handler(
      { order_identifier: '#9999' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('#9999');
  });

  it('returns error for non-refundable order status', async () => {
    const order = makeOrderWrite({ displayFinancialStatus: 'REFUNDED' });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('refund_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('REFUNDED');
  });

  it('issues full refund via line items', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        refundCreate: {
          refund: {
            id: 'gid://shopify/Refund/601',
            totalRefundedSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('refund_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { refundAmount: number; orderNumber: string; customerName: string };
    expect(data.refundAmount).toBe(100);
    expect(data.orderNumber).toBe('#1001');
    expect(data.customerName).toBe('Alice Smith');
    expect(result.display).toContain('Alice Smith');
    expect(result.display).toContain('#1001');
  });

  it('issues partial refund via transaction', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        refundCreate: {
          refund: {
            id: 'gid://shopify/Refund/602',
            totalRefundedSet: { shopMoney: { amount: '25.00', currencyCode: 'USD' } },
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('refund_order')!.handler(
      { order_identifier: '#1001', amount: 25 },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { refundAmount: number };
    expect(data.refundAmount).toBe(25);

    // Verify partial refund used transaction-based approach
    const secondCall = graphql.mock.calls[1] as [string, { input: { transactions: unknown[] } }];
    expect(secondCall[1].input.transactions).toBeDefined();
  });

  it('surfaces Shopify userErrors', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        refundCreate: {
          refund: null,
          userErrors: [{ field: 'amount', message: 'Amount exceeds refundable balance' }],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('refund_order')!.handler(
      { order_identifier: '#1001', amount: 999 },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Amount exceeds refundable balance');
  });
});

// ─── cancel_order handler ──────────────────────────────────────────────────────

describe('cancel_order handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns error if order already cancelled', async () => {
    const order = makeOrderWrite({ cancelledAt: '2024-01-10T10:00:00Z' });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('cancel_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('already cancelled');
  });

  it('returns error if order is fully fulfilled', async () => {
    const order = makeOrderWrite({ displayFulfillmentStatus: 'FULFILLED' });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('cancel_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('fulfilled');
  });

  it('cancels order and returns restocked status', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        orderCancel: {
          orderCancelUserErrors: [],
          job: { id: 'gid://shopify/Job/701' },
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('cancel_order')!.handler(
      { order_identifier: '#1001', restock: true },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { orderNumber: string; restocked: boolean; customerName: string };
    expect(data.orderNumber).toBe('#1001');
    expect(data.restocked).toBe(true);
    expect(data.customerName).toBe('Alice Smith');
    expect(result.display).toContain('restocked');
  });

  it('maps reason string to Shopify enum and passes restock:false', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        orderCancel: { orderCancelUserErrors: [], job: null },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    await registry.get('cancel_order')!.handler(
      { order_identifier: '#1001', reason: 'fraud', restock: false },
      makeContext()
    );

    const secondCall = graphql.mock.calls[1] as [string, { reason: string; restock: boolean }];
    expect(secondCall[1].reason).toBe('FRAUD');
    expect(secondCall[1].restock).toBe(false);
  });
});

// ─── fulfill_order handler ─────────────────────────────────────────────────────

describe('fulfill_order handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns error if order already fulfilled', async () => {
    const order = makeOrderWrite({ displayFulfillmentStatus: 'FULFILLED' });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('fulfill_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('already fulfilled');
  });

  it('returns error when no open fulfillment orders', async () => {
    const order = makeOrderWrite({
      fulfillmentOrders: {
        edges: [
          {
            node: {
              id: 'gid://shopify/FulfillmentOrder/301',
              status: 'CLOSED',
              lineItems: { edges: [] },
            },
          },
        ],
      },
    });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('fulfill_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('No open fulfillment orders');
  });

  it('fulfills order and includes tracking in display', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        fulfillmentCreateV2: {
          fulfillment: {
            id: 'gid://shopify/Fulfillment/501',
            status: 'SUCCESS',
            trackingInfo: [{ number: '1Z999AA10123456784', company: 'UPS', url: null }],
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('fulfill_order')!.handler(
      { order_identifier: '#1001', tracking_number: '1Z999AA10123456784', tracking_company: 'UPS' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { orderNumber: string; trackingNumber: string };
    expect(data.orderNumber).toBe('#1001');
    expect(data.trackingNumber).toBe('1Z999AA10123456784');
    expect(result.display).toContain('1Z999AA10123456784');
  });

  it('fulfills without tracking when not provided', async () => {
    const order = makeOrderWrite();
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        fulfillmentCreateV2: {
          fulfillment: {
            id: 'gid://shopify/Fulfillment/502',
            status: 'SUCCESS',
            trackingInfo: [],
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('fulfill_order')!.handler(
      { order_identifier: '#1001' },
      makeContext()
    );
    expect(result.success).toBe(true);
    const data = result.data as { trackingNumber: null };
    expect(data.trackingNumber).toBeNull();
  });
});

// ─── update_tracking handler ───────────────────────────────────────────────────

describe('update_tracking handler', () => {
  beforeEach(() => mockGetShopifyClient.mockReset());

  it('returns error when no active fulfillment', async () => {
    const order = makeOrderWrite({ fulfillments: [] });
    const graphql = vi.fn().mockResolvedValue({ orders: { edges: [{ node: order }] } });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('update_tracking')!.handler(
      { order_identifier: '#1001', tracking_number: 'NEW123' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('No active fulfillment');
  });

  it('updates tracking on existing fulfillment', async () => {
    const order = makeOrderWrite({
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        {
          id: 'gid://shopify/Fulfillment/501',
          status: 'SUCCESS',
          trackingInfo: [{ number: 'OLD123', company: null, url: null }],
        },
      ],
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        fulfillmentTrackingInfoUpdateV2: {
          fulfillment: {
            id: 'gid://shopify/Fulfillment/501',
            trackingInfo: [{ number: 'NEW123', company: 'FedEx', url: null }],
          },
          userErrors: [],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('update_tracking')!.handler(
      { order_identifier: '#1001', tracking_number: 'NEW123', tracking_company: 'FedEx' },
      makeContext()
    );

    expect(result.success).toBe(true);
    const data = result.data as { trackingNumber: string; trackingCompany: string };
    expect(data.trackingNumber).toBe('NEW123');
    expect(data.trackingCompany).toBe('FedEx');
    expect(result.display).toContain('NEW123');

    // Verify the right fulfillment ID was used
    const secondCall = graphql.mock.calls[1] as [
      string,
      { fulfillmentId: string; trackingInfoInput: { number: string; company: string } },
    ];
    expect(secondCall[1].fulfillmentId).toBe('gid://shopify/Fulfillment/501');
    expect(secondCall[1].trackingInfoInput.number).toBe('NEW123');
    expect(secondCall[1].trackingInfoInput.company).toBe('FedEx');
  });

  it('surfaces Shopify userErrors on tracking update', async () => {
    const order = makeOrderWrite({
      fulfillments: [
        {
          id: 'gid://shopify/Fulfillment/501',
          status: 'SUCCESS',
          trackingInfo: [],
        },
      ],
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ orders: { edges: [{ node: order }] } })
      .mockResolvedValueOnce({
        fulfillmentTrackingInfoUpdateV2: {
          fulfillment: null,
          userErrors: [{ field: 'tracking_number', message: 'Invalid tracking number' }],
        },
      });
    mockGetShopifyClient.mockResolvedValue(makeClient((q, v) => graphql(q, v)));

    const registry = new ToolRegistry();
    registerShopifyOrderWriteTools({} as never, registry);
    const result = await registry.get('update_tracking')!.handler(
      { order_identifier: '#1001', tracking_number: 'BAD' },
      makeContext()
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid tracking number');
  });
});
