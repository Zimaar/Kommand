import { eq } from 'drizzle-orm';
import { db } from '../../db/connection.js';
import { accountingConnections } from '../../db/schema.js';
import { config } from '../../config/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { getRedisClient } from '../../utils/redis.js';
import { AppError } from '../../utils/errors.js';

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh if <5 min until expiry
const REFRESH_LOCK_TTL_MS = 30_000; // 30-second lock

interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface XeroConnectionRow {
  id: string;
  userId: string;
  tenantId: string;
  tenantName: string | null;
  accessToken: string;
  refreshToken: string;
  tokenIv: string;
  tokenExpiresAt: Date | null;
}

/**
 * Decodes the compound tokenIv field ("accessIv|refreshIv") written by xero-auth.ts
 * and returns plaintext access + refresh tokens.
 */
function decryptTokenPair(row: Pick<XeroConnectionRow, 'accessToken' | 'refreshToken' | 'tokenIv'>): {
  accessToken: string;
  refreshToken: string;
} {
  const [accessIv, refreshIv] = row.tokenIv.split('|') as [string, string];
  return {
    accessToken: decrypt(row.accessToken, accessIv),
    refreshToken: decrypt(row.refreshToken, refreshIv),
  };
}

export class XeroClient {
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt: Date;

  private readonly connectionId: string;
  private readonly tenantId: string;

  constructor(row: XeroConnectionRow) {
    const { accessToken, refreshToken } = decryptTokenPair(row);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    // If DB has no expiry, treat token as already expired so it refreshes immediately.
    this.tokenExpiresAt = row.tokenExpiresAt ?? new Date(0);
    this.connectionId = row.id;
    this.tenantId = row.tenantId;
  }

  // ── Token refresh ────────────────────────────────────────────────────────────

  /**
   * Ensures the access token is valid with at least TOKEN_REFRESH_BUFFER_MS remaining.
   * Uses a Redis NX lock to prevent concurrent refresh races across worker processes.
   */
  private async ensureFreshToken(): Promise<void> {
    if (Date.now() + TOKEN_REFRESH_BUFFER_MS < this.tokenExpiresAt.getTime()) {
      return; // Token is still fresh enough
    }

    if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET) {
      throw AppError.externalApiError('Xero OAuth credentials are not configured');
    }

    const redis = getRedisClient();
    const lockKey = `xero_refresh_lock:${this.connectionId}`;

    // Atomic SET NX — avoids the INCR/EXPIRE race condition
    const acquired = await redis.set(lockKey, '1', 'PX', REFRESH_LOCK_TTL_MS, 'NX');

    if (!acquired) {
      // Another process holds the lock — wait for it to finish, then read fresh tokens from DB
      await sleep(1500);
      const [row] = await db
        .select({
          id: accountingConnections.id,
          userId: accountingConnections.userId,
          tenantId: accountingConnections.tenantId,
          tenantName: accountingConnections.tenantName,
          accessToken: accountingConnections.accessToken,
          refreshToken: accountingConnections.refreshToken,
          tokenIv: accountingConnections.tokenIv,
          tokenExpiresAt: accountingConnections.tokenExpiresAt,
        })
        .from(accountingConnections)
        .where(eq(accountingConnections.id, this.connectionId))
        .limit(1);

      if (row) {
        const { accessToken, refreshToken } = decryptTokenPair(row);
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        this.tokenExpiresAt = row.tokenExpiresAt ?? new Date(0);
      }
      return;
    }

    try {
      const response = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: config.XERO_CLIENT_ID,
          client_secret: config.XERO_CLIENT_SECRET,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw AppError.externalApiError(`Xero token refresh failed (${response.status}): ${text}`);
      }

      const data = (await response.json()) as TokenRefreshResponse;
      const expiresAt = new Date(Date.now() + data.expires_in * 1000);

      // Encrypt updated tokens with fresh IVs each time
      const { ciphertext: accessCt, iv: accessIv } = encrypt(data.access_token);
      const { ciphertext: refreshCt, iv: refreshIv } = encrypt(data.refresh_token);

      await db
        .update(accountingConnections)
        .set({
          accessToken: accessCt,
          refreshToken: refreshCt,
          tokenIv: `${accessIv}|${refreshIv}`,
          tokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(accountingConnections.id, this.connectionId));

      // Update in-memory state
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = expiresAt;
    } finally {
      await redis.del(lockKey);
    }
  }

  // ── Request helpers ──────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Xero-Tenant-Id': this.tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempt = 0
  ): Promise<Response> {
    const response = await fetch(url, options);

    // Retry on Xero rate limit (429)
    if (response.status === 429 && attempt < 2) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '2', 10);
      await sleep(retryAfter * 1000);
      return this.fetchWithRetry(url, options, attempt + 1);
    }

    if (!response.ok) {
      throw AppError.externalApiError(
        `Xero API error ${response.status}: ${response.statusText} — ${url}`
      );
    }

    return response;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async get<T = unknown>(endpoint: string): Promise<T> {
    await this.ensureFreshToken();
    const url = `${XERO_API_BASE}${endpoint}`;
    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers(),
    });
    return response.json() as Promise<T>;
  }

  async post<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    await this.ensureFreshToken();
    const url = `${XERO_API_BASE}${endpoint}`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  async put<T = unknown>(endpoint: string, body: unknown): Promise<T> {
    await this.ensureFreshToken();
    const url = `${XERO_API_BASE}${endpoint}`;
    const response = await this.fetchWithRetry(url, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Load and decrypt the active Xero connection for a user, returning a ready-to-use XeroClient.
 * Throws if no active Xero connection exists.
 */
export async function getXeroClient(userId: string): Promise<XeroClient> {
  const [row] = await db
    .select({
      id: accountingConnections.id,
      userId: accountingConnections.userId,
      tenantId: accountingConnections.tenantId,
      tenantName: accountingConnections.tenantName,
      accessToken: accountingConnections.accessToken,
      refreshToken: accountingConnections.refreshToken,
      tokenIv: accountingConnections.tokenIv,
      tokenExpiresAt: accountingConnections.tokenExpiresAt,
    })
    .from(accountingConnections)
    .where(eq(accountingConnections.userId, userId))
    .limit(1);

  if (!row || !row.tenantId) {
    throw AppError.notFound(
      'No active Xero connection found — please connect your Xero account first'
    );
  }

  // tenantId is verified non-null above; cast via unknown to satisfy strict null-check
  return new XeroClient(row as unknown as XeroConnectionRow);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
