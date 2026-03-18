import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getShopifyClient } from './index.js';
import type { ShopifyClient } from './client.js';

// ─── GraphQL types ────────────────────────────────────────────────────────────

interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

interface VariantNode {
  id: string;
  title: string;
  price: string;
  inventoryQuantity: number;
  inventoryItem: { id: string };
}

interface ProductNode {
  id: string;
  title: string;
  status: string;
  productType: string;
  createdAt: string;
  variants: {
    edges: Array<{
      node: VariantNode;
    }>;
  };
}

interface ProductsResponse {
  products: {
    edges: Array<{ node: ProductNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface InventoryLevelNode {
  available: number;
  location: { name: string; id: string };
  item: { id: string; variant: { displayName: string; product: { title: string } } | null };
}

interface InventoryLevelsResponse {
  inventoryItems: {
    edges: Array<{ node: { id: string; inventoryLevels: { edges: Array<{ node: InventoryLevelNode }> } } }>;
  };
}

interface LocationInventoryResponse {
  locations: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        inventoryLevels: {
          edges: Array<{
            node: {
              available: number;
              item: {
                id: string;
                variant: { displayName: string; product: { title: string; id: string } } | null;
              };
            };
          }>;
        };
      };
    }>;
  };
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query GetProducts($query: String, $first: Int!, $after: String) {
    products(first: $first, query: $query, after: $after, sortKey: TITLE) {
      edges {
        node {
          id
          title
          status
          productType
          createdAt
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LOW_STOCK_QUERY = `
  query LowStockProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          id
          title
          status
          productType
          createdAt
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const INVENTORY_ADJUST_MUTATION = `
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
        reason
        changes {
          name
          delta
          quantityAfterChange
          location { name }
        }
      }
      userErrors { field message code }
    }
  }
`;

interface InventoryAdjustResponse {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: {
      id: string;
      reason: string;
      changes: Array<{
        name: string;
        delta: number;
        quantityAfterChange: number;
        location: { name: string };
      }>;
    } | null;
    userErrors: Array<{ field: string; message: string; code: string }>;
  };
}

const PRICE_UPDATE_MUTATION = `
  mutation ProductVariantUpdate($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        title
        price
      }
      userErrors { field message }
    }
  }
`;

interface PriceUpdateResponse {
  productVariantUpdate: {
    productVariant: { id: string; title: string; price: string } | null;
    userErrors: Array<{ field: string; message: string }>;
  };
}

const LOCATIONS_QUERY = `
  query GetLocations {
    locations(first: 10, includeLegacy: false) {
      edges {
        node { id name }
      }
    }
  }
`;

interface LocationsResponse {
  locations: {
    edges: Array<{ node: { id: string; name: string } }>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fuzzy match: every word in the query appears (case-insensitive) in the target */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  // word-by-word: all words in query must appear somewhere in target
  return q.split(/\s+/).every((word) => t.includes(word));
}

/** Fetch all products matching an optional text filter, up to `limit` */
async function fetchProducts(
  client: ShopifyClient,
  search?: string,
  limit = 10
): Promise<ProductNode[]> {
  const all: ProductNode[] = [];
  let after: string | null = null;
  let remaining = limit;

  do {
    const batch = Math.min(remaining, 250);
    // Shopify title search is prefix-based; we do further fuzzy filtering client-side
    const gqlQuery = search ? `title:*${search}* OR title:${search}*` : undefined;
    const data: ProductsResponse = await client.graphql<ProductsResponse>(PRODUCTS_QUERY, {
      query: gqlQuery,
      first: batch,
      after,
    });
    all.push(...data.products.edges.map((e: { node: ProductNode }) => e.node));
    remaining -= data.products.edges.length;
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  } while (remaining > 0);

  return all;
}

/** Pick the best variant match; defaults to first variant if no match */
function pickVariant(product: ProductNode, variantHint?: string): VariantNode {
  const variants = product.variants.edges.map((e) => e.node);
  if (!variantHint) return variants[0]!;
  const match = variants.find((v) => fuzzyMatch(variantHint, v.title));
  return match ?? variants[0]!;
}

/** Aggregate total inventory across all variants */
function totalInventory(product: ProductNode): number {
  return product.variants.edges.reduce((sum, { node }) => sum + node.inventoryQuantity, 0);
}

/** Min price across all variants */
function minPrice(product: ProductNode): string {
  const prices = product.variants.edges.map(({ node }) => parseFloat(node.price));
  return Math.min(...prices).toFixed(2);
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const GetProductsInput = z.object({
  search: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetProductInventoryInput = z.object({
  product_name: z.string().optional(),
});

const UpdateProductPriceInput = z.object({
  product_name: z.string().min(1),
  new_price: z.number().positive(),
  variant: z.string().optional(),
});

const UpdateInventoryInput = z.object({
  product_name: z.string().min(1),
  adjustment: z.number().int(),
  variant: z.string().optional(),
  reason: z.string().optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

function makeGetProducts(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetProductsInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    const products = await fetchProducts(client, input.search, input.limit);

    // If search term given, apply client-side fuzzy filter
    const filtered = input.search
      ? products.filter((p) => fuzzyMatch(input.search!, p.title))
      : products;

    const data = filtered.slice(0, input.limit).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      price: minPrice(p),
      inventory: totalInventory(p),
      variantCount: p.variants.edges.length,
      variants: p.variants.edges.map(({ node }) => ({
        id: node.id,
        title: node.title,
        price: node.price,
        inventory: node.inventoryQuantity,
      })),
      productType: p.productType,
      createdAt: p.createdAt,
    }));

    return { success: true, data };
  };
}

function makeGetProductInventory(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetProductInventoryInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Get primary location for inventory levels
    const locationData = await client.graphql<LocationsResponse>(LOCATIONS_QUERY, {});
    const primaryLocation = locationData.locations.edges[0]?.node;
    const locationName = primaryLocation?.name ?? 'Default';

    if (input.product_name) {
      // Specific product search
      const products = await fetchProducts(client, input.product_name, 50);
      const matched = products.filter((p) => fuzzyMatch(input.product_name!, p.title));

      if (matched.length === 0) {
        return { success: false, error: `No products found matching "${input.product_name}"` };
      }

      const data = matched.flatMap((p) =>
        p.variants.edges.map(({ node: v }) => ({
          productTitle: p.title,
          variantId: v.id,
          variant: v.title,
          available: v.inventoryQuantity,
          location: locationName,
          price: v.price,
        }))
      );

      return { success: true, data };
    }

    // No product specified — return low-stock items (< 10 units)
    const LOW_STOCK_THRESHOLD = 10;
    const all: ProductNode[] = [];
    let after: string | null = null;

    do {
      const page: ProductsResponse = await client.graphql<ProductsResponse>(LOW_STOCK_QUERY, {
        first: 250,
        after,
      });
      all.push(...page.products.edges.map((e: { node: ProductNode }) => e.node));
      if (!page.products.pageInfo.hasNextPage) break;
      after = page.products.pageInfo.endCursor;
    } while (true);

    const lowStock = all.flatMap((p) =>
      p.variants.edges
        .filter(({ node: v }) => v.inventoryQuantity < LOW_STOCK_THRESHOLD)
        .map(({ node: v }) => ({
          productTitle: p.title,
          variantId: v.id,
          variant: v.title,
          available: v.inventoryQuantity,
          location: locationName,
          price: v.price,
        }))
    );

    return {
      success: true,
      data: lowStock,
      display:
        lowStock.length === 0
          ? 'All products have sufficient stock (10+ units).'
          : `Found ${lowStock.length} variant(s) with low stock (< ${LOW_STOCK_THRESHOLD} units).`,
    };
  };
}

function makeUpdateProductPrice(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = UpdateProductPriceInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Fetch candidates
    const products = await fetchProducts(client, input.product_name, 50);
    const matched = products.filter((p) => fuzzyMatch(input.product_name, p.title));

    if (matched.length === 0) {
      return { success: false, error: `No products found matching "${input.product_name}"` };
    }

    // Multiple ambiguous matches — ask the AI to clarify
    if (matched.length > 1 && !input.variant) {
      const options = matched.map((p) => ({
        id: p.id,
        title: p.title,
        price: minPrice(p),
        variantCount: p.variants.edges.length,
      }));
      return {
        success: true,
        data: {
          requiresSelection: true,
          matches: options,
          message: `Found ${matched.length} products matching "${input.product_name}". Which one did you mean?`,
        },
      };
    }

    const product = matched[0]!;
    const variant = pickVariant(product, input.variant);
    const oldPrice = variant.price;

    const data = await client.graphql<PriceUpdateResponse>(PRICE_UPDATE_MUTATION, {
      input: {
        id: variant.id,
        price: input.new_price.toFixed(2),
      },
    });

    if (data.productVariantUpdate.userErrors.length > 0) {
      const msg = data.productVariantUpdate.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Price update failed: ${msg}` };
    }

    const currency = context.currency;
    return {
      success: true,
      data: {
        productTitle: product.title,
        variantTitle: variant.title,
        variantId: variant.id,
        oldPrice: parseFloat(oldPrice),
        newPrice: round2(input.new_price),
        currency,
      },
      display: `Changed ${product.title}${variant.title !== 'Default Title' ? ` (${variant.title})` : ''} price from ${currency} ${parseFloat(oldPrice).toFixed(2)} to ${currency} ${input.new_price.toFixed(2)}.`,
    };
  };
}

function makeUpdateInventory(db: DB) {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = UpdateInventoryInput.parse(params);
    const client = await getShopifyClient(context.userId, db);

    // Fetch product
    const products = await fetchProducts(client, input.product_name, 50);
    const matched = products.filter((p) => fuzzyMatch(input.product_name, p.title));

    if (matched.length === 0) {
      return { success: false, error: `No products found matching "${input.product_name}"` };
    }

    const product = matched[0]!;
    const variant = pickVariant(product, input.variant);
    const currentQty = variant.inventoryQuantity;
    const newTotal = currentQty + input.adjustment;

    // Get the primary location
    const locationData = await client.graphql<LocationsResponse>(LOCATIONS_QUERY, {});
    const primaryLocation = locationData.locations.edges[0]?.node;
    if (!primaryLocation) {
      return { success: false, error: 'No inventory location found for this store' };
    }

    // Map reason to Shopify's inventory adjustment reason
    const reasonMap: Record<string, string> = {
      received: 'received',
      sold: 'sold',
      returned: 'return_restock',
      damaged: 'damaged',
      shrinkage: 'shrinkage',
      correction: 'correction',
    };
    const rawReason = (input.reason ?? '').toLowerCase();
    const adjustmentReason = reasonMap[rawReason] ?? 'correction';

    const adjustData = await client.graphql<InventoryAdjustResponse>(INVENTORY_ADJUST_MUTATION, {
      input: {
        reason: adjustmentReason,
        name: 'available',
        changes: [
          {
            inventoryItemId: variant.inventoryItem.id,
            locationId: primaryLocation.id,
            delta: input.adjustment,
          },
        ],
      },
    });

    if (adjustData.inventoryAdjustQuantities.userErrors.length > 0) {
      const msg = adjustData.inventoryAdjustQuantities.userErrors.map((e) => e.message).join('; ');
      return { success: false, error: `Inventory adjustment failed: ${msg}` };
    }

    const changes = adjustData.inventoryAdjustQuantities.inventoryAdjustmentGroup?.changes ?? [];
    const actualNewTotal =
      changes[0]?.quantityAfterChange ?? newTotal;

    const sign = input.adjustment >= 0 ? '+' : '';
    return {
      success: true,
      data: {
        productTitle: product.title,
        variantTitle: variant.title,
        variantId: variant.id,
        previousQuantity: currentQty,
        adjustment: input.adjustment,
        newQuantity: actualNewTotal,
        location: primaryLocation.name,
        reason: adjustmentReason,
      },
      display: `Adjusted ${product.title}${variant.title !== 'Default Title' ? ` (${variant.title})` : ''} inventory by ${sign}${input.adjustment} → new total: ${actualNewTotal} units at ${primaryLocation.name}.`,
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerShopifyProductTools(db: DB, registry: ToolRegistry): void {
  registry.register({
    name: 'get_products',
    description:
      'List Shopify products with price and inventory. Use when the merchant asks to see products, search for a product, or browse their catalog.',
    platform: 'shopify',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        search: { type: 'string', description: 'Optional search term to filter products by name' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
      },
      required: [],
    },
    handler: makeGetProducts(db),
  });

  registry.register({
    name: 'get_product_inventory',
    description:
      'Check inventory levels. Use when the merchant asks about stock for a specific product, or asks what is low on stock / running out. If no product is specified, returns all variants with fewer than 10 units.',
    platform: 'shopify',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        product_name: {
          type: 'string',
          description: 'Product name to look up. Omit to get all low-stock items.',
        },
      },
      required: [],
    },
    handler: makeGetProductInventory(db),
  });

  registry.register({
    name: 'update_product_price',
    description:
      'Update the price of a product or specific variant. Use when the merchant wants to change a price. Requires confirmation (tier 2). If multiple products match the name, will ask for clarification.',
    platform: 'shopify',
    confirmationTier: 2,
    inputSchema: {
      properties: {
        product_name: { type: 'string', description: 'Product name (fuzzy match)' },
        new_price: { type: 'number', description: 'New price in store currency' },
        variant: { type: 'string', description: 'Optional variant name e.g. "Large / Red"' },
      },
      required: ['product_name', 'new_price'],
    },
    handler: makeUpdateProductPrice(db),
  });

  registry.register({
    name: 'update_inventory',
    description:
      'Adjust inventory quantity for a product. Use positive numbers to add stock, negative to remove. Use when the merchant says they received new stock, made a sale offline, or needs to correct inventory. Requires confirmation (tier 1).',
    platform: 'shopify',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        product_name: { type: 'string', description: 'Product name (fuzzy match)' },
        adjustment: {
          type: 'integer',
          description: 'Units to add (positive) or remove (negative)',
        },
        variant: { type: 'string', description: 'Optional variant name' },
        reason: {
          type: 'string',
          description: 'Reason: received, sold, returned, damaged, shrinkage, correction',
        },
      },
      required: ['product_name', 'adjustment'],
    },
    handler: makeUpdateInventory(db),
  });
}
