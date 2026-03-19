import type { FastifyInstance } from 'fastify';
import { eq, and, count as sqlCount } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users, stores, accountingConnections, channels, commands } from '../db/schema.js';
import { AppError } from '../utils/errors.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { ok } from '../utils/response.js';
import { ShopifyClient } from '../tools/shopify/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShopifyOrdersResponse {
  orders: Array<{ total_price: string }>;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function statsRoutes(app: FastifyInstance) {
  // ── GET /stats/overview ────────────────────────────────────────────────────
  // Quick KPIs for the dashboard overview panel.
  // Returns: orders today, revenue today, pending actions, active connections.
  // Query: clerkId
  app.get('/stats/overview', async (request) => {
    const query   = request.query as Record<string, string>;
    const clerkId = query.clerkId;
    if (!clerkId) throw AppError.unauthorized('Missing Clerk authentication');

    await checkRateLimit(clerkId);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) throw AppError.notFound('User not found');

    // ── Pending commands ─────────────────────────────────────────────────────
    const [{ value: pendingCount }] = await db
      .select({ value: sqlCount() })
      .from(commands)
      .where(and(eq(commands.userId, user.id), eq(commands.status, 'pending')));

    // ── Active connections count ─────────────────────────────────────────────
    const [{ value: activeStores }]      = await db.select({ value: sqlCount() }).from(stores)                .where(and(eq(stores.userId, user.id),                eq(stores.isActive, true)));
    const [{ value: activeAccounting }]  = await db.select({ value: sqlCount() }).from(accountingConnections).where(and(eq(accountingConnections.userId, user.id), eq(accountingConnections.isActive, true)));
    const [{ value: activeChannelCount }] = await db.select({ value: sqlCount() }).from(channels)             .where(and(eq(channels.userId, user.id),              eq(channels.isActive, true)));

    const activeConnections =
      Number(activeStores) + Number(activeAccounting) + Number(activeChannelCount);

    // ── Shopify: today's orders + revenue ────────────────────────────────────
    let ordersToday  = 0;
    let revenueToday = 0;

    const [shopify] = await db
      .select({
        shopDomain:  stores.shopDomain,
        accessToken: stores.accessToken,
        tokenIv:     stores.tokenIv,
      })
      .from(stores)
      .where(
        and(
          eq(stores.userId,   user.id),
          eq(stores.isActive, true),
          eq(stores.platform, 'shopify')
        )
      )
      .limit(1);

    if (shopify) {
      try {
        const client     = new ShopifyClient(shopify.shopDomain, shopify.accessToken, shopify.tokenIv);
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const data = await client.rest<ShopifyOrdersResponse>(
          'GET',
          `/orders.json?status=any&created_at_min=${todayStart.toISOString()}&fields=total_price&limit=250`
        );

        ordersToday  = data.orders.length;
        revenueToday = data.orders.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
      } catch (err) {
        // Non-fatal: log and fall through with zeros
        app.log.warn({ err }, '[stats] Shopify orders fetch failed — returning zeros');
      }
    }

    return ok({
      ordersToday,
      revenueToday:      Math.round(revenueToday * 100) / 100,
      pendingActions:    Number(pendingCount),
      activeConnections,
    });
  });
}
