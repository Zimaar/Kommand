import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';

// ─── GraphQL types ────────────────────────────────────────────────────────────

interface DiscountCodeEdge {
  node: { code: string; usageCount: number };
}

interface DiscountAmountValue {
  __typename: 'DiscountAmount';
  amount: { amount: string; currencyCode: string };
}

interface DiscountPercentageValue {
  __typename: 'DiscountPercentage';
  percentage: number;
}

type DiscountValue = DiscountAmountValue | DiscountPercentageValue;

interface DiscountCodeBasicFields {
  __typename: 'DiscountCodeBasic';
  title: string;
  status: string;
  codes: { edges: DiscountCodeEdge[] };
  customerGets: { value: DiscountValue };
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
}

interface DiscountCodeOtherFields {
  __typename: string;
  title: string;
  status: string;
  codes: { edges: DiscountCodeEdge[] };
  startsAt: string;
  endsAt: string | null;
}

type DiscountCodeVariant = DiscountCodeBasicFields | DiscountCodeOtherFields;

interface CodeDiscountNodesResponse {
  codeDiscountNodes: {
    edges: Array<{ node: { id: string; codeDiscount: DiscountCodeVariant } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface CodeDiscountNodeByCodeResponse {
  codeDiscountNodeByCode: {
    id: string;
    codeDiscount: { __typename: string; title: string; status: string };
  } | null;
}

interface DiscountCreateResponse {
  discountCodeBasicCreate: {
    codeDiscountNode: {
      id: string;
      codeDiscount: {
        codes: { edges: Array<{ node: { code: string } }> };
        status: string;
      };
    } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

interface DiscountDeactivateResponse {
  discountCodeDeactivate: {
    codeDiscountNode: { id: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

// ─── GraphQL queries & mutations ──────────────────────────────────────────────

const LIST_DISCOUNTS_GQL = `
  query ListActiveDiscounts($first: Int!, $after: String) {
    codeDiscountNodes(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          id
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title
              status
              codes(first: 5) { edges { node { code usageCount } } }
              customerGets {
                value {
                  ... on DiscountAmount { __typename amount { amount currencyCode } }
                  ... on DiscountPercentage { __typename percentage }
                }
              }
              startsAt
              endsAt
              usageLimit
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              codes(first: 5) { edges { node { code usageCount } } }
              startsAt
              endsAt
            }
            ... on DiscountCodeBxgy {
              title
              status
              codes(first: 5) { edges { node { code usageCount } } }
              startsAt
              endsAt
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const GET_DISCOUNT_BY_CODE_GQL = `
  query GetDiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic { title status }
        ... on DiscountCodeFreeShipping { title status }
        ... on DiscountCodeBxgy { title status }
      }
    }
  }
`;

const CREATE_DISCOUNT_GQL = `
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) { edges { node { code } } }
            status
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const DEACTIVATE_DISCOUNT_GQL = `
  mutation DiscountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDiscountNode(node: {
  id: string;
  codeDiscount: DiscountCodeVariant;
}): {
  code: string;
  type: string;
  value: number | null;
  currency: string | null;
  usageCount: number;
  usageLimit: number | null;
  startsAt: string;
  endsAt: string | null;
  status: string;
} | null {
  const d = node.codeDiscount;
  const firstCode = d.codes.edges[0]?.node;
  if (!firstCode) return null;

  let type = 'other';
  let value: number | null = null;
  let currency: string | null = null;
  let usageLimit: number | null = null;

  if (d.__typename === 'DiscountCodeBasic') {
    const basic = d as DiscountCodeBasicFields;
    usageLimit = basic.usageLimit;
    const val = basic.customerGets.value;
    if (val.__typename === 'DiscountPercentage') {
      type = 'percentage';
      value = Math.round(val.percentage * 100 * 10) / 10; // e.g. 0.20 → 20
    } else if (val.__typename === 'DiscountAmount') {
      type = 'fixed_amount';
      value = parseFloat(val.amount.amount);
      currency = val.amount.currencyCode;
    }
  } else if (d.__typename === 'DiscountCodeFreeShipping') {
    type = 'free_shipping';
  } else if (d.__typename === 'DiscountCodeBxgy') {
    type = 'buy_x_get_y';
  }

  return {
    code: firstCode.code,
    type,
    value,
    currency,
    usageCount: firstCode.usageCount,
    usageLimit,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    status: d.status,
  };
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const ListActiveDiscountsInput = z.object({});

const CreateDiscountInput = z.object({
  code: z.string().min(1).max(255).transform((s) => s.toUpperCase()),
  type: z.enum(['percentage', 'fixed_amount']),
  value: z.number().positive(),
  starts_at: z.string().optional(),
  ends_at: z.string().optional(),
  usage_limit: z.number().int().positive().optional(),
});

const DisableDiscountInput = z.object({
  code: z.string().min(1),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeListActiveDiscounts(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    ListActiveDiscountsInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const all: ReturnType<typeof normalizeDiscountNode>[] = [];
    let after: string | null = null;

    do {
      const data = await client.graphql<CodeDiscountNodesResponse>(LIST_DISCOUNTS_GQL, {
        first: 50,
        after,
      });
      for (const edge of data.codeDiscountNodes.edges) {
        const normalized = normalizeDiscountNode(edge.node);
        if (normalized) all.push(normalized);
      }
      if (!data.codeDiscountNodes.pageInfo.hasNextPage) break;
      after = data.codeDiscountNodes.pageInfo.endCursor;
    } while (true);

    return { success: true, data: all };
  };
}

function makeCreateDiscount(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = CreateDiscountInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const customerGetsValue =
      input.type === 'percentage'
        ? { discountPercentage: input.value / 100 }
        : {
            discountAmount: {
              amount: String(input.value.toFixed(2)),
              appliesOnEachItem: false,
            },
          };

    const variables = {
      basicCodeDiscount: {
        title: input.code,
        codes: [input.code],
        startsAt: input.starts_at ?? new Date().toISOString(),
        ...(input.ends_at ? { endsAt: input.ends_at } : {}),
        ...(input.usage_limit ? { usageLimit: input.usage_limit } : {}),
        appliesOncePerCustomer: false,
        customerGets: {
          value: customerGetsValue,
          items: { allItems: true },
        },
        customerSelection: { all: true },
      },
    };

    const data = await client.graphql<DiscountCreateResponse>(CREATE_DISCOUNT_GQL, variables);
    const result = data.discountCodeBasicCreate;

    if (result.userErrors.length > 0) {
      const msg = result.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Failed to create discount: ${msg}` };
    }

    const valueLabel =
      input.type === 'percentage'
        ? `${input.value}% off`
        : `${context.currency} ${input.value.toFixed(2)} off`;

    const dateLabel = input.ends_at
      ? `active until ${input.ends_at.slice(0, 10)}`
      : 'no expiry';

    return {
      success: true,
      data: {
        code: input.code,
        type: input.type,
        value: input.value,
        startsAt: input.starts_at ?? new Date().toISOString(),
        endsAt: input.ends_at ?? null,
        usageLimit: input.usage_limit ?? null,
        status: 'ACTIVE',
      },
      display: `Discount code ${input.code} created — ${valueLabel}, ${dateLabel}.`,
    };
  };
}

function makeDisableDiscount(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = DisableDiscountInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Look up the discount node by code
    const lookup = await client.graphql<CodeDiscountNodeByCodeResponse>(GET_DISCOUNT_BY_CODE_GQL, {
      code: input.code.toUpperCase(),
    });

    const node = lookup.codeDiscountNodeByCode;
    if (!node) {
      return { success: false, error: `Discount code "${input.code}" not found.` };
    }

    if (node.codeDiscount.status === 'EXPIRED') {
      return {
        success: false,
        error: `Discount code "${input.code}" is already expired.`,
      };
    }

    // Deactivate
    const result = await client.graphql<DiscountDeactivateResponse>(DEACTIVATE_DISCOUNT_GQL, {
      id: node.id,
    });

    if (result.discountCodeDeactivate.userErrors.length > 0) {
      const msg = result.discountCodeDeactivate.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Failed to disable discount: ${msg}` };
    }

    return {
      success: true,
      data: { code: input.code.toUpperCase(), previousStatus: node.codeDiscount.status },
      display: `Discount code ${input.code.toUpperCase()} has been deactivated.`,
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerShopifyDiscountTools(db: DB, registry: ToolRegistry): void {
  registry.register({
    name: 'list_active_discounts',
    description:
      'List all currently active discount codes with their type, value, usage count, and expiry. Use when the merchant asks what discounts are running, or wants to review their active promo codes.',
    platform: 'shopify',
    confirmationTier: 0,
    inputSchema: { properties: {}, required: [] },
    handler: makeListActiveDiscounts(db),
  });

  registry.register({
    name: 'create_discount',
    description:
      'Create a new discount code — percentage or fixed amount off the entire order. Use when the merchant wants to create a promo code. Applies to all products and all customers by default. Requires confirmation (tier 1).',
    platform: 'shopify',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        code: { type: 'string', description: 'Discount code (e.g. SUMMER20). Will be uppercased.' },
        type: { type: 'string', enum: ['percentage', 'fixed_amount'] },
        value: {
          type: 'number',
          description: 'Discount value: percentage (0–100) for percentage type, or amount for fixed_amount',
        },
        starts_at: { type: 'string', description: 'ISO 8601 start date (defaults to now)' },
        ends_at: { type: 'string', description: 'ISO 8601 expiry date (omit for no expiry)' },
        usage_limit: { type: 'number', description: 'Max total redemptions (omit for unlimited)' },
      },
      required: ['code', 'type', 'value'],
    },
    handler: makeCreateDiscount(db),
  });

  registry.register({
    name: 'disable_discount',
    description:
      'Deactivate an existing discount code so it can no longer be used. Use when the merchant wants to end a promotion or disable a specific promo code. Requires confirmation (tier 1).',
    platform: 'shopify',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        code: { type: 'string', description: 'The discount code to deactivate' },
      },
      required: ['code'],
    },
    handler: makeDisableDiscount(db),
  });
}
