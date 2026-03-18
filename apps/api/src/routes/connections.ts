import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { stores, users, accountingConnections, channels } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

export async function connectionRoutes(app: FastifyInstance) {
  // GET /connections?clerkId=xxx — returns all connections for a user
  app.get<{ Querystring: { clerkId?: string } }>(
    '/connections',
    async (request) => {
      const { clerkId } = request.query;
      if (!clerkId) {
        throw AppError.validationError('clerkId query parameter is required');
      }

      // Look up user by Clerk ID
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) {
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
          provider: accountingConnections.provider,
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
          channelType: channels.channelType,
          isActive: channels.isActive,
        })
        .from(channels)
        .where(eq(channels.userId, user.id));

      return { shopify: shopifyStore, accounting, channels: channelRows };
    }
  );
}
