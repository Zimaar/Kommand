import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { accountingConnections, users } from '../db/schema.js';
import { config } from '../config/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { getRedisClient } from '../utils/redis.js';
import { AppError } from '../utils/errors.js';

const PKCE_TTL_SECONDS = 300; // 5 minutes

const XERO_SCOPES = [
  'openid',
  'profile',
  'email',
  'accounting.transactions',
  'accounting.contacts',
  'accounting.settings',
  'offline_access',
].join(' ');

interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface XeroTenant {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

// Encrypt both tokens with separate IVs; pack IVs as "accessIv|refreshIv" in a single field.
function encryptTokenPair(accessToken: string, refreshToken: string) {
  const { ciphertext: accessCt, iv: accessIv } = encrypt(accessToken);
  const { ciphertext: refreshCt, iv: refreshIv } = encrypt(refreshToken);
  return {
    accessToken: accessCt,
    refreshToken: refreshCt,
    tokenIv: `${accessIv}|${refreshIv}`,
  };
}

async function exchangeCode(code: string, codeVerifier: string): Promise<XeroTokenResponse> {
  if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET || !config.XERO_REDIRECT_URI) {
    throw AppError.externalApiError('Xero OAuth credentials are not configured');
  }

  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.XERO_REDIRECT_URI,
      client_id: config.XERO_CLIENT_ID,
      client_secret: config.XERO_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw AppError.externalApiError(`Xero token exchange failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<XeroTokenResponse>;
}

async function fetchTenants(accessToken: string): Promise<XeroTenant[]> {
  const response = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw AppError.externalApiError(`Failed to fetch Xero tenants (${response.status})`);
  }

  return response.json() as Promise<XeroTenant[]>;
}

async function upsertConnection(
  userId: string,
  tenant: XeroTenant,
  tokens: XeroTokenResponse
) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const encrypted = encryptTokenPair(tokens.access_token, tokens.refresh_token);

  await db
    .insert(accountingConnections)
    .values({
      userId,
      platform: 'xero',
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      ...encrypted,
      tokenExpiresAt: expiresAt,
      scopes: XERO_SCOPES.split(' '),
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [accountingConnections.userId, accountingConnections.platform, accountingConnections.tenantId],
      set: {
        ...encrypted,
        tenantName: tenant.tenantName,
        tokenExpiresAt: expiresAt,
        isActive: true,
        updatedAt: new Date(),
      },
    });
}

export async function xeroAuthRoutes(app: FastifyInstance) {
  // ── Initiate OAuth + PKCE ────────────────────────────────────────────────────
  app.get<{ Querystring: { userId?: string } }>(
    '/auth/xero',
    async (request, reply) => {
      const { userId } = request.query;
      if (!userId) throw AppError.validationError('userId is required');

      if (!config.XERO_CLIENT_ID || !config.XERO_REDIRECT_URI) {
        throw AppError.externalApiError('Xero OAuth credentials are not configured');
      }

      // PKCE: code_verifier is 32 random bytes → base64url (43 chars, within 43-128 range)
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      // State nonce — ties the callback back to userId + codeVerifier
      const state = crypto.randomBytes(16).toString('hex');

      const redis = getRedisClient();
      await redis.set(
        `xero_oauth:${state}`,
        JSON.stringify({ userId, codeVerifier }),
        'EX',
        PKCE_TTL_SECONDS
      );

      const authUrl = new URL('https://login.xero.com/identity/connect/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.XERO_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', config.XERO_REDIRECT_URI);
      authUrl.searchParams.set('scope', XERO_SCOPES);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      return reply.redirect(authUrl.toString());
    }
  );

  // ── OAuth callback ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/xero/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error) {
        throw AppError.externalApiError(`Xero OAuth denied: ${error}`);
      }

      if (!code || !state) {
        throw AppError.validationError('Missing code or state parameter');
      }

      // Validate state and retrieve userId + codeVerifier from Redis
      const redis = getRedisClient();
      const stored = await redis.get(`xero_oauth:${state}`);
      if (!stored) {
        throw AppError.unauthorized('OAuth state expired or invalid — please restart the connection');
      }
      await redis.del(`xero_oauth:${state}`);

      const { userId, codeVerifier } = JSON.parse(stored) as {
        userId: string;
        codeVerifier: string;
      };

      // Exchange code for tokens
      const tokens = await exchangeCode(code, codeVerifier);

      // Fetch tenants (Xero organisations) the user has access to
      const tenants = await fetchTenants(tokens.access_token);

      if (tenants.length === 0) {
        throw AppError.externalApiError('No Xero organisations found for this account');
      }

      // Single tenant — auto-select and store
      if (tenants.length === 1) {
        const tenant = tenants[0]!;
        await upsertConnection(userId, tenant, tokens);
        app.log.info({ userId, tenantId: tenant.tenantId, tenantName: tenant.tenantName }, 'Xero connected');
        return reply.redirect(`${config.DASHBOARD_URL}/settings/connections?xero=connected`);
      }

      // Multiple tenants — store encrypted tokens + tenants in Redis for selection step.
      // Key by a random pendingId (not userId) so concurrent OAuth flows don't overwrite each other.
      const pendingId = crypto.randomBytes(16).toString('hex');
      const encryptedTokens = encryptTokenPair(tokens.access_token, tokens.refresh_token);
      await redis.set(
        `xero_pending:${pendingId}`,
        JSON.stringify({ userId, ...encryptedTokens, expiresIn: tokens.expires_in, tenants }),
        'EX',
        PKCE_TTL_SECONDS
      );

      const selectUrl = new URL(`${config.DASHBOARD_URL}/onboarding/xero/select-tenant`);
      selectUrl.searchParams.set('pendingId', pendingId);
      return reply.redirect(selectUrl.toString());
    }
  );

  // ── Tenant selection (multi-tenant) ──────────────────────────────────────────
  // Called by the dashboard after the user picks an org.
  // Body: { pendingId: string; tenantId: string }
  app.post<{ Body: { pendingId?: string; tenantId?: string } }>(
    '/auth/xero/select-tenant',
    async (request) => {
      const { pendingId, tenantId } = request.body ?? {};
      if (!pendingId) throw AppError.validationError('pendingId is required');
      if (!tenantId) throw AppError.validationError('tenantId is required');

      const redis = getRedisClient();
      const raw = await redis.get(`xero_pending:${pendingId}`);
      if (!raw) {
        throw AppError.unauthorized('Tenant selection window expired — please reconnect Xero');
      }

      const { userId, accessToken, refreshToken, tokenIv, expiresIn, tenants } = JSON.parse(raw) as {
        userId: string;
        accessToken: string;
        refreshToken: string;
        tokenIv: string;
        expiresIn: number;
        tenants: XeroTenant[];
      };
      const [accessIv, refreshIv] = tokenIv.split('|') as [string, string];
      const tokens: XeroTokenResponse = {
        access_token: decrypt(accessToken, accessIv!),
        refresh_token: decrypt(refreshToken, refreshIv!),
        expires_in: expiresIn,
        token_type: 'Bearer',
      };

      const tenant = tenants.find((t) => t.tenantId === tenantId);
      if (!tenant) {
        throw AppError.validationError('tenantId is not in the list of available organisations');
      }

      // Resolve our internal userId to ensure the user exists
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw AppError.unauthorized('User not found');

      await upsertConnection(userId, tenant, tokens);
      await redis.del(`xero_pending:${pendingId}`);

      app.log.info({ userId, tenantId: tenant.tenantId, tenantName: tenant.tenantName }, 'Xero tenant selected');

      return { connected: true, tenantName: tenant.tenantName };
    }
  );
}
