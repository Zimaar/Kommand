import { eq, and } from 'drizzle-orm';
import type { DB } from '../../db/connection.js';
import { stores } from '../../db/schema.js';
import { AppError } from '../../utils/errors.js';
import { ShopifyClient } from './client.js';

export async function getShopifyClient(userId: string, db: DB): Promise<ShopifyClient> {
  const rows = await db
    .select({
      shopDomain: stores.shopDomain,
      accessToken: stores.accessToken,
      tokenIv: stores.tokenIv,
    })
    .from(stores)
    .where(
      and(
        eq(stores.userId, userId),
        eq(stores.platform, 'shopify'),
        eq(stores.isActive, true)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    throw AppError.notFound(
      'No active Shopify store connected. Connect your store at /auth/shopify'
    );
  }

  const { shopDomain, accessToken, tokenIv } = rows[0]!;
  return new ShopifyClient(shopDomain, accessToken, tokenIv);
}
