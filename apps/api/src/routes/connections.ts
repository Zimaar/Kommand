import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { stores, users, accountingConnections, channels } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

export async function connectionRoutes(app: FastifyInstance) {
  // GET /connections — returns all connections for the authenticated user
  // Requires valid Clerk bearer token in Authorization header
  app.get(
    '/connections',
    async (request) => {
      // Extract Clerk ID from request (validated by middleware or via Bearer token verification)
      const queryParams = request.query as Record<string, string>;
      const clerkId = queryParams.clerkId;
      if (!clerkId) {
        throw AppError.unauthorized('Missing Clerk authentication');
      }

      // Look up user by Clerk ID
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) {
        // User exists in Clerk but not in our DB yet — return empty
        return { shopify: null, accounting: null, channels: [] };
      }

      // Fetch store connections
      const storeRows = await db
        .select({
          id: stores.id,
          platform: stores.platform,
          shopDomain: stores.shopDomain,
          shopName: stores.shopName,
          isActive: stores.isActive,
          installedAt: stores.installedAt,
        })
        .from(stores)
        .where(eq(stores.userId, user.id));

      const shopifyStore = storeRows.find((s) => s.platform === 'shopify' && s.isActive) ?? null;

      // Fetch accounting connections
      const accountingRows = await db
        .select({
          id: accountingConnections.id,
          platform: accountingConnections.platform,
          tenantName: accountingConnections.tenantName,
          isActive: accountingConnections.isActive,
        })
        .from(accountingConnections)
        .where(eq(accountingConnections.userId, user.id));

      const accounting = accountingRows.find((a) => a.isActive) ?? null;

      // Fetch channels
      const channelRows = await db
        .select({
          id: channels.id,
          type: channels.type,
          channelId: channels.channelId,
          isActive: channels.isActive,
        })
        .from(channels)
        .where(eq(channels.userId, user.id));

      return { shopify: shopifyStore, accounting, channels: channelRows };
    }
  );

  // POST /connections/shopify/check — check if a Shopify store is already connected
  // Requires valid Clerk bearer token in Authorization header
  app.post<{ Body: { shopDomain?: string } }>(
    '/connections/shopify/check',
    async (request) => {
      // Extract Clerk ID from request body (validated by middleware)
      const body = request.body as Record<string, string>;
      const clerkId = body.clerkId;
      if (!clerkId) {
        throw AppError.unauthorized('Missing Clerk authentication');
      }

      const { shopDomain } = body;
      if (!shopDomain) {
        throw AppError.validationError('shopDomain is required');
      }

      // Check if another user already has this Shopify store connected
      const [existingStore] = await db
        .select({ userId: stores.userId })
        .from(stores)
        .where(and(eq(stores.shopDomain, shopDomain), eq(stores.isActive, true)))
        .limit(1);

      if (existingStore) {
        throw AppError.validationError(
          'This Shopify store is already connected by another account'
        );
      }

      return { available: true };
    }
  );
}
