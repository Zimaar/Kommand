import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';
import type { ShopifyClient } from './client.js';
import { round2 } from './math.js';

// ─── Detailed order fetch for write operations ────────────────────────────────

const ORDER_WRITE_QUERY = `
  query GetOrderForWrite($query: String!) {
    orders(first: 1, query: $query) {
      edges {
        node {
          id
          name
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          customer { displayName }
          email
          totalPriceSet { shopMoney { amount currencyCode } }
          transactions(first: 10) {
            id
            kind
            status
            amountSet { shopMoney { amount currencyCode } }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                quantity
                refundableQuantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
          fulfillmentOrders(first: 5) {
            edges {
              node {
                id
                status
                lineItems(first: 50) {
                  edges {
                    node { id remainingQuantity }
                  }
                }
              }
            }
          }
          fulfillments(first: 5) {
            id
            status
            trackingInfo { number company url }
          }
        }
      }
    }
  }
`;

interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

interface Transaction {
  id: string;
  kind: string;
  status: string;
  amountSet: { shopMoney: MoneyV2 };
}

interface LineItemWrite {
  id: string;
  quantity: number;
  refundableQuantity: number;
  originalUnitPriceSet: { shopMoney: MoneyV2 };
}

interface FulfillmentOrderLineItem {
  id: string;
  remainingQuantity: number;
}

interface FulfillmentOrder {
  id: string;
  status: string;
  lineItems: { edges: Array<{ node: FulfillmentOrderLineItem }> };
}

interface FulfillmentRecord {
  id: string;
  status: string;
  trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
}

interface OrderWrite {
  id: string;
  name: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  customer: { displayName: string } | null;
  email: string | null;
  totalPriceSet: { shopMoney: MoneyV2 };
  transactions: Transaction[];
  lineItems: { edges: Array<{ node: LineItemWrite }> };
  fulfillmentOrders: { edges: Array<{ node: FulfillmentOrder }> };
  fulfillments: FulfillmentRecord[];
}

interface OrderWriteResponse {
  orders: {
    edges: Array<{ node: OrderWrite }>;
  };
}

async function fetchOrderForWrite(
  client: ShopifyClient,
  identifier: string
): Promise<OrderWrite | null> {
  const normalized = identifier.startsWith('#') ? identifier : `#${identifier}`;
  const data = await client.graphql<OrderWriteResponse>(ORDER_WRITE_QUERY, {
    query: `name:${normalized}`,
  });
  return data.orders.edges[0]?.node ?? null;
}


// ─── GraphQL mutations ────────────────────────────────────────────────────────

const REFUND_CREATE_MUTATION = `
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

interface RefundCreateResponse {
  refundCreate: {
    refund: { id: string; totalRefundedSet: { shopMoney: MoneyV2 } } | null;
    userErrors: Array<{ field: string; message: string }>;
  };
}

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $refund: Boolean!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      refund: $refund
      staffNote: $staffNote
    ) {
      orderCancelUserErrors { field message code }
      job { id }
    }
  }
`;

interface OrderCancelResponse {
  orderCancel: {
    orderCancelUserErrors: Array<{ field: string; message: string; code: string }>;
    job: { id: string } | null;
  };
}

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

interface FulfillmentCreateResponse {
  fulfillmentCreateV2: {
    fulfillment: {
      id: string;
      status: string;
      trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
    } | null;
    userErrors: Array<{ field: string; message: string }>;
  };
}

const TRACKING_UPDATE_MUTATION = `
  mutation FulfillmentTrackingUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdateV2(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

interface TrackingUpdateResponse {
  fulfillmentTrackingInfoUpdateV2: {
    fulfillment: {
      id: string;
      trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
    } | null;
    userErrors: Array<{ field: string; message: string }>;
  };
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const RefundOrderInput = z.object({
  order_identifier: z.string().min(1),
  amount: z.number().positive().optional(),
  reason: z.string().optional(),
});

const CancelOrderInput = z.object({
  order_identifier: z.string().min(1),
  reason: z.string().optional(),
  restock: z.boolean().default(true),
});

const FulfillOrderInput = z.object({
  order_identifier: z.string().min(1),
  tracking_number: z.string().optional(),
  tracking_company: z.string().optional(),
});

const UpdateTrackingInput = z.object({
  order_identifier: z.string().min(1),
  tracking_number: z.string().min(1),
  tracking_company: z.string().optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

function makeRefundOrder(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = RefundOrderInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const order = await fetchOrderForWrite(client, input.order_identifier);
    if (!order) {
      return { success: false, error: `Order ${input.order_identifier} not found` };
    }

    const refundableStatuses = ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'];
    if (!refundableStatuses.includes(order.displayFinancialStatus)) {
      return {
        success: false,
        error: `Order ${order.name} cannot be refunded (status: ${order.displayFinancialStatus})`,
      };
    }

    const currency = order.totalPriceSet.shopMoney.currencyCode;
    const customerName = order.customer?.displayName ?? 'Guest';
    const orderTotal = parseFloat(order.totalPriceSet.shopMoney.amount);

    // Build refund input: partial amount via transaction, full via line items
    let refundInput: Record<string, unknown>;

    if (input.amount !== undefined) {
      // Partial refund — find a SALE transaction to reference
      const saleTx = order.transactions.find(
        (tx) => tx.kind === 'SALE' && tx.status === 'SUCCESS'
      );
      if (!saleTx) {
        return { success: false, error: `No payment transaction found for order ${order.name}` };
      }
      refundInput = {
        orderId: order.id,
        note: input.reason,
        transactions: [
          {
            parentId: saleTx.id,
            amount: input.amount.toFixed(2),
            kind: 'REFUND',
            gateway: 'shopify_payments',
          },
        ],
      };
    } else {
      // Full refund via all refundable line items
      const refundLineItems = order.lineItems.edges
        .filter(({ node }) => node.refundableQuantity > 0)
        .map(({ node }) => ({
          lineItemId: node.id,
          quantity: node.refundableQuantity,
          restockType: 'RETURN',
        }));

      refundInput = {
        orderId: order.id,
        note: input.reason,
        refundLineItems: refundLineItems.length > 0 ? refundLineItems : undefined,
        transactions: refundLineItems.length === 0
          ? [] // No refundable items — still try to create for shipping etc.
          : undefined,
      };
    }

    const data = await client.graphql<RefundCreateResponse>(REFUND_CREATE_MUTATION, {
      input: refundInput,
    });

    if (data.refundCreate.userErrors.length > 0) {
      const msg = data.refundCreate.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Refund failed: ${msg}` };
    }

    const refundAmount =
      input.amount ??
      parseFloat(data.refundCreate.refund?.totalRefundedSet.shopMoney.amount ?? String(orderTotal));

    return {
      success: true,
      data: {
        refundAmount: round2(refundAmount),
        orderNumber: order.name,
        customerName,
        currency,
        refundId: data.refundCreate.refund?.id,
      },
      display: `Refunded ${currency} ${round2(refundAmount).toFixed(2)} to ${customerName} for order ${order.name}`,
    };
  };
}

function makeCancelOrder(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = CancelOrderInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const order = await fetchOrderForWrite(client, input.order_identifier);
    if (!order) {
      return { success: false, error: `Order ${input.order_identifier} not found` };
    }

    if (order.cancelledAt) {
      return { success: false, error: `Order ${order.name} is already cancelled` };
    }

    if (order.displayFulfillmentStatus === 'FULFILLED') {
      return {
        success: false,
        error: `Order ${order.name} is already fulfilled and cannot be cancelled`,
      };
    }

    const customerName = order.customer?.displayName ?? 'Guest';
    const currency = order.totalPriceSet.shopMoney.currencyCode;
    const total = round2(parseFloat(order.totalPriceSet.shopMoney.amount));

    // Map reason string to Shopify enum
    const reasonMap: Record<string, string> = {
      customer: 'CUSTOMER',
      fraud: 'FRAUD',
      inventory: 'INVENTORY',
      declined: 'DECLINED',
      staff: 'STAFF',
    };
    const rawReason = (input.reason ?? '').toLowerCase();
    const cancelReason = reasonMap[rawReason] ?? 'OTHER';

    const data = await client.graphql<OrderCancelResponse>(ORDER_CANCEL_MUTATION, {
      orderId: order.id,
      reason: cancelReason,
      restock: input.restock,
      refund: true, // auto-refund if paid
      staffNote: input.reason,
    });

    if (data.orderCancel.orderCancelUserErrors.length > 0) {
      const msg = data.orderCancel.orderCancelUserErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Cancel failed: ${msg}` };
    }

    return {
      success: true,
      data: {
        orderNumber: order.name,
        customerName,
        total,
        currency,
        restocked: input.restock,
        jobId: data.orderCancel.job?.id,
      },
      display: `Cancelled order ${order.name} (${customerName}, ${currency} ${total.toFixed(2)}). Items ${input.restock ? 'have been restocked' : 'were not restocked'}.`,
    };
  };
}

function makeFulfillOrder(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = FulfillOrderInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const order = await fetchOrderForWrite(client, input.order_identifier);
    if (!order) {
      return { success: false, error: `Order ${input.order_identifier} not found` };
    }

    if (order.displayFulfillmentStatus === 'FULFILLED') {
      return { success: false, error: `Order ${order.name} is already fulfilled` };
    }

    if (order.cancelledAt) {
      return { success: false, error: `Order ${order.name} has been cancelled` };
    }

    // Find open fulfillment orders
    const openFulfillmentOrders = order.fulfillmentOrders.edges
      .filter(({ node }) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(node.status))
      .map(({ node }) => ({ fulfillmentOrderId: node.id }));

    if (openFulfillmentOrders.length === 0) {
      return { success: false, error: `No open fulfillment orders found for ${order.name}` };
    }

    const fulfillmentInput: Record<string, unknown> = {
      lineItemsByFulfillmentOrder: openFulfillmentOrders,
      notifyCustomer: true,
    };

    if (input.tracking_number) {
      fulfillmentInput['trackingInfo'] = {
        number: input.tracking_number,
        ...(input.tracking_company ? { company: input.tracking_company } : {}),
      };
    }

    const data = await client.graphql<FulfillmentCreateResponse>(FULFILLMENT_CREATE_MUTATION, {
      fulfillment: fulfillmentInput,
    });

    if (data.fulfillmentCreateV2.userErrors.length > 0) {
      const msg = data.fulfillmentCreateV2.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Fulfillment failed: ${msg}` };
    }

    const fulfillment = data.fulfillmentCreateV2.fulfillment;
    const trackingNumber = fulfillment?.trackingInfo[0]?.number ?? input.tracking_number ?? null;

    return {
      success: true,
      data: {
        orderNumber: order.name,
        customerName: order.customer?.displayName ?? 'Guest',
        fulfillmentId: fulfillment?.id,
        trackingNumber,
        trackingCompany: input.tracking_company ?? null,
      },
      display: `Marked order ${order.name} as fulfilled${trackingNumber ? ` with tracking ${trackingNumber}` : ''}.`,
    };
  };
}

function makeUpdateTracking(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = UpdateTrackingInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const order = await fetchOrderForWrite(client, input.order_identifier);
    if (!order) {
      return { success: false, error: `Order ${input.order_identifier} not found` };
    }

    // Find most recent fulfillment
    const fulfillment = order.fulfillments.find((f) =>
      ['SUCCESS', 'PENDING', 'OPEN'].includes(f.status)
    );

    if (!fulfillment) {
      return {
        success: false,
        error: `No active fulfillment found for order ${order.name}. Fulfill the order first.`,
      };
    }

    const trackingInfoInput: Record<string, unknown> = {
      number: input.tracking_number,
    };
    if (input.tracking_company) {
      trackingInfoInput['company'] = input.tracking_company;
    }

    const data = await client.graphql<TrackingUpdateResponse>(TRACKING_UPDATE_MUTATION, {
      fulfillmentId: fulfillment.id,
      trackingInfoInput,
      notifyCustomer: true,
    });

    if (data.fulfillmentTrackingInfoUpdateV2.userErrors.length > 0) {
      const msg = data.fulfillmentTrackingInfoUpdateV2.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Tracking update failed: ${msg}` };
    }

    return {
      success: true,
      data: {
        orderNumber: order.name,
        fulfillmentId: fulfillment.id,
        trackingNumber: input.tracking_number,
        trackingCompany: input.tracking_company ?? null,
      },
      display: `Updated tracking for order ${order.name} to ${input.tracking_number}${input.tracking_company ? ` (${input.tracking_company})` : ''}.`,
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerShopifyOrderWriteTools(db: DB, registry: ToolRegistry): void {
  registry.register({
    name: 'refund_order',
    description:
      'Refund a Shopify order — full or partial amount. Use when the merchant asks to issue a refund for an order. Requires confirmation (tier 2). Always validates the order exists and is refundable before proceeding.',
    platform: 'shopify',
    confirmationTier: 2,
    inputSchema: {
      properties: {
        order_identifier: { type: 'string', description: 'Order number e.g. "#1234" or "1234"' },
        amount: { type: 'number', description: 'Refund amount. Omit for full refund.' },
        reason: { type: 'string', description: 'Reason for the refund' },
      },
      required: ['order_identifier'],
    },
    handler: makeRefundOrder(db),
  });

  registry.register({
    name: 'cancel_order',
    description:
      'Cancel a Shopify order. Use when the merchant asks to cancel an order. Requires confirmation (tier 2). Will not cancel already-fulfilled orders.',
    platform: 'shopify',
    confirmationTier: 2,
    inputSchema: {
      properties: {
        order_identifier: { type: 'string', description: 'Order number e.g. "#1234" or "1234"' },
        reason: {
          type: 'string',
          description: 'Cancellation reason: customer, fraud, inventory, declined, staff, or other',
        },
        restock: { type: 'boolean', default: true, description: 'Whether to restock inventory' },
      },
      required: ['order_identifier'],
    },
    handler: makeCancelOrder(db),
  });

  registry.register({
    name: 'fulfill_order',
    description:
      'Mark a Shopify order as fulfilled with optional tracking info. Use when the merchant says an order has shipped. Requires confirmation (tier 1).',
    platform: 'shopify',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        order_identifier: { type: 'string', description: 'Order number e.g. "#1234" or "1234"' },
        tracking_number: { type: 'string', description: 'Shipping tracking number' },
        tracking_company: { type: 'string', description: 'Carrier name e.g. UPS, FedEx, USPS' },
      },
      required: ['order_identifier'],
    },
    handler: makeFulfillOrder(db),
  });

  registry.register({
    name: 'update_tracking',
    description:
      'Update tracking number on an already-fulfilled Shopify order. Use when the merchant has a new tracking number for a shipment. Requires confirmation (tier 1).',
    platform: 'shopify',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        order_identifier: { type: 'string', description: 'Order number e.g. "#1234" or "1234"' },
        tracking_number: { type: 'string', description: 'New tracking number' },
        tracking_company: { type: 'string', description: 'Carrier name e.g. UPS, FedEx, USPS' },
      },
      required: ['order_identifier', 'tracking_number'],
    },
    handler: makeUpdateTracking(db),
  });
}
