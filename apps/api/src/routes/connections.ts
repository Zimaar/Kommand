import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { stores, users, accountingConnections, channels } from '../db/schema.js';
import { AppError } from '../utils/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ConnectionTable = 'store' | 'accounting' | 'channel';

interface FoundConnection {
  table: ConnectionTable;
  id: string;
}

/**
 * Locates a connection record by UUID across all three tables,
 * scoped to the authenticated user. Returns null if not found.
 */
async function findConnection(
  userId: string,
  id: string
): Promise<FoundConnection | null> {
  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, id), eq(stores.userId, userId)))
    .limit(1);
  if (store) return { table: 'store', id: store.id };

  const [acct] = await db
    .select({ id: accountingConnections.id })
    .from(accountingConnections)
    .where(and(eq(accountingConnections.id, id), eq(accountingConnections.userId, userId)))
    .limit(1);
  if (acct) return { table: 'accounting', id: acct.id };

  const [chan] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.userId, userId)))
    .limit(1);
  if (chan) return { table: 'channel', id: chan.id };

  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function connectionRoutes(app: FastifyInstance) {
  // ── GET /connections ────────────────────────────────────────────────────────
  // Returns all connections for the authenticated user with rich metadata.
  // clerkId passed as query param from the dashboard proxy.
  app.get(
    '/connections',
    async (request) => {
      const queryParams = request.query as Record<string, string>;
      const clerkId = queryParams.clerkId;
      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (!user) {
        return { shopify: null, accounting: null, channels: [] };
      }

      // Stores — all rows so the UI can show inactive ones too
      const storeRows = await db
        .select({
          id: stores.id,
          platform: stores.platform,
          shopDomain: stores.shopDomain,
          shopName: stores.shopName,
          isActive: stores.isActive,
          installedAt: stores.installedAt,
          lastSyncedAt: stores.lastSyncedAt,
          updatedAt: stores.updatedAt,
        })
        .from(stores)
        .where(eq(stores.userId, user.id));

      // Return the active Shopify store, or the most recently updated inactive one
      const shopifyStore =
        storeRows.find((s) => s.platform === 'shopify' && s.isActive) ??
        storeRows.find((s) => s.platform === 'shopify')                ??
        null;

      // Accounting connections — all rows
      const accountingRows = await db
        .select({
          id: accountingConnections.id,
          platform: accountingConnections.platform,
          tenantName: accountingConnections.tenantName,
          isActive: accountingConnections.isActive,
          tokenExpiresAt: accountingConnections.tokenExpiresAt,
          updatedAt: accountingConnections.updatedAt,
        })
        .from(accountingConnections)
        .where(eq(accountingConnections.userId, user.id));

      const accounting =
        accountingRows.find((a) => a.isActive) ??
        accountingRows[0]                        ??
        null;

      // Channels — all rows (may include inactive)
      const channelRows = await db
        .select({
          id: channels.id,
          type: channels.type,
          channelId: channels.channelId,
          isActive: channels.isActive,
          updatedAt: channels.updatedAt,
        })
        .from(channels)
        .where(eq(channels.userId, user.id));

      return { shopify: shopifyStore, accounting, channels: channelRows };
    }
  );

  // ── DELETE /connections/:id ─────────────────────────────────────────────────
  // Soft-disconnects a connection by UUID (sets isActive=false).
  // Body: { clerkId: string }
  app.delete<{ Params: { id: string }; Body: { clerkId?: string } }>(
    '/connections/:id',
    async (request) => {
      const { clerkId } = request.body ?? {};
      const { id }      = request.params;

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');
      if (!id)      throw AppError.validationError('Connection id is required');

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      if (!user) throw AppError.unauthorized('User not found');

      const found = await findConnection(user.id, id);
      if (!found) throw AppError.notFound('Connection not found');

      const now = new Date();

      if (found.table === 'store') {
        await db
          .update(stores)
          .set({ isActive: false, updatedAt: now })
          .where(eq(stores.id, id));
      } else if (found.table === 'accounting') {
        await db
          .update(accountingConnections)
          .set({ isActive: false, updatedAt: now })
          .where(eq(accountingConnections.id, id));
      } else {
        await db
          .update(channels)
          .set({ isActive: false, updatedAt: now })
          .where(eq(channels.id, id));
      }

      app.log.info({ userId: user.id, connectionId: id, table: found.table }, '[connections] disconnected');
      return { success: true };
    }
  );

  // ── POST /connections/:id/refresh ───────────────────────────────────────────
  // Attempts to refresh / re-validate a connection.
  //   • Stores   → Shopify tokens are long-lived; re-marks as active
  //   • Channels → re-marks as active
  //   • Accounting → full OAuth refresh is M5 scope; returns reconnect signal
  // Body: { clerkId: string }
  app.post<{ Params: { id: string }; Body: { clerkId?: string } }>(
    '/connections/:id/refresh',
    async (request) => {
      const { clerkId } = request.body ?? {};
      const { id }      = request.params;

      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');
      if (!id)      throw AppError.validationError('Connection id is required');

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      if (!user) throw AppError.unauthorized('User not found');

      const found = await findConnection(user.id, id);
      if (!found) throw AppError.notFound('Connection not found');

      const now = new Date();

      if (found.table === 'store') {
        // Shopify tokens don't expire — re-mark active and update timestamp
        await db
          .update(stores)
          .set({ isActive: true, updatedAt: now })
          .where(eq(stores.id, id));
        return { refreshed: true };
      }

      if (found.table === 'channel') {
        await db
          .update(channels)
          .set({ isActive: true, updatedAt: now })
          .where(eq(channels.id, id));
        return { refreshed: true };
      }

      // Accounting: full OAuth refresh is implemented in M5 (Xero milestone).
      // Return a signal so the UI can show a "Reconnect" button.
      const [acct] = await db
        .select({ platform: accountingConnections.platform })
        .from(accountingConnections)
        .where(eq(accountingConnections.id, id))
        .limit(1);

      return {
        refreshed: false,
        requiresReconnect: true,
        platform: acct?.platform ?? 'accounting',
      };
    }
  );

  // ── POST /connections/shopify/check ────────────────────────────────────────
  // Check if a Shopify store domain is already connected by another account.
  app.post<{ Body: { shopDomain?: string } }>(
    '/connections/shopify/check',
    async (request) => {
      const body = request.body as Record<string, string>;
      const clerkId = body.clerkId;
      if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

      const { shopDomain } = body;
      if (!shopDomain) throw AppError.validationError('shopDomain is required');

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
