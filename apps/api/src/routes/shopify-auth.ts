import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { stores } from '../db/schema.js';
import { config } from '../config/index.js';
import { encrypt } from '../utils/encryption.js';
import { getRedisClient } from '../utils/redis.js';
import { AppError } from '../utils/errors.js';

const NONCE_TTL_SECONDS = 300; // 5 minutes
const SHOPIFY_SCOPES = [
  'read_orders',
  'read_products',
  'write_products',
  'read_customers',
  'read_inventory',
  'write_inventory',
  'read_fulfillments',
  'write_fulfillments',
  'read_discounts',
  'write_discounts',
  'read_price_rules',
  'write_price_rules',
].join(',');

// Verify Shopify HMAC signature on callback query params
function verifyShopifyHmac(query: Record<string, string>): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.entries(rest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const expected = crypto
    .createHmac('sha256', config.SHOPIFY_API_SECRET ?? '')
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
  } catch {
    return false;
  }
}

export async function shopifyAuthRoutes(app: FastifyInstance) {
  // ── Initiate OAuth ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { shop?: string; userId?: string } }>(
    '/auth/shopify',
    async (request, reply) => {
      const { shop, userId } = request.query;

      if (!shop || !shop.endsWith('.myshopify.com')) {
        throw AppError.validationError('shop parameter must be a valid myshopify.com domain');
      }

      if (!userId) {
        throw AppError.validationError('userId is required (will be replaced by Clerk session in production)');
      }

      if (!config.SHOPIFY_API_KEY) {
        throw AppError.externalApiError('SHOPIFY_API_KEY is not configured');
      }

      // Generate nonce and store in Redis
      const nonce = crypto.randomBytes(16).toString('hex');
      const redis = getRedisClient();
      await redis.set(`shopify_oauth:${nonce}`, userId, 'EX', NONCE_TTL_SECONDS);

      const redirectUri = `${config.API_URL}/auth/shopify/callback`;
      const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
      authUrl.searchParams.set('client_id', config.SHOPIFY_API_KEY);
      authUrl.searchParams.set('scope', SHOPIFY_SCOPES);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', nonce);

      return reply.redirect(authUrl.toString());
    }
  );

  // ── OAuth callback ──────────────────────────────────────────────────────────
  app.get<{
    Querystring: {
      code?: string;
      hmac?: string;
      shop?: string;
      state?: string;
      timestamp?: string;
    };
  }>('/auth/shopify/callback', async (request, reply) => {
    const { code, shop, state, ...rest } = request.query;
    const queryForHmac = { ...rest, code: code ?? '', shop: shop ?? '', state: state ?? '', timestamp: rest.timestamp ?? '' };

    // 1. Validate HMAC
    if (!verifyShopifyHmac(queryForHmac as Record<string, string>)) {
      throw AppError.unauthorized('Invalid Shopify HMAC signature');
    }

    // 2. Validate state (nonce) against Redis
    if (!state) throw AppError.validationError('Missing state parameter');
    const redis = getRedisClient();
    const userId = await redis.get(`shopify_oauth:${state}`);

    if (!userId) {
      throw AppError.unauthorized('OAuth state expired or invalid — please restart the connection');
    }
    await redis.del(`shopify_oauth:${state}`);

    // 3. Exchange code for permanent access token
    if (!code || !shop) {
      throw AppError.validationError('Missing code or shop parameter');
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.SHOPIFY_API_KEY,
        client_secret: config.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      throw AppError.externalApiError('Failed to exchange Shopify OAuth code for access token');
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      scope: string;
    };

    // 4. Encrypt the access token
    const { ciphertext, iv } = encrypt(tokenData.access_token);

    // 5. Upsert store record
    const scopes = tokenData.scope.split(',');

    const existingStore = await db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(
          eq(stores.userId, userId),
          eq(stores.platform, 'shopify'),
          eq(stores.shopDomain, shop)
        )
      )
      .limit(1);

    if (existingStore.length > 0) {
      await db
        .update(stores)
        .set({
          accessToken: ciphertext,
          tokenIv: iv,
          scopes,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(stores.id, existingStore[0]!.id));
    } else {
      await db.insert(stores).values({
        userId,
        platform: 'shopify',
        shopDomain: shop,
        shopName: shop.replace('.myshopify.com', ''),
        accessToken: ciphertext,
        tokenIv: iv,
        scopes,
        isActive: true,
      });
    }

    app.log.info({ userId, shop }, 'Shopify store connected');

    // 6. Redirect to dashboard
    return reply.redirect(`${config.DASHBOARD_URL}/onboarding?step=2&shopify=connected`);
  });
}
