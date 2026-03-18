import { decrypt } from '../../utils/encryption.js';
import { AppError } from '../../utils/errors.js';

const SHOPIFY_API_VERSION = '2025-01';

export class ShopifyClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(
    private readonly shopDomain: string,
    encryptedToken: string,
    tokenIv: string
  ) {
    this.token = decrypt(encryptedToken, tokenIv);
    this.baseUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  }

  async graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}/graphql.json`;

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw AppError.externalApiError(
        `Shopify GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`
      );
    }

    return json.data as T;
  }

  async rest<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchWithRetry(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return response.json() as Promise<T>;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempt = 0
  ): Promise<Response> {
    const response = await fetch(url, options);

    // Retry on rate limit (429)
    if (response.status === 429 && attempt < 2) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1', 10);
      await sleep(retryAfter * 1000);
      return this.fetchWithRetry(url, options, attempt + 1);
    }

    if (!response.ok) {
      throw AppError.externalApiError(
        `Shopify API error ${response.status}: ${response.statusText} — ${url}`
      );
    }

    return response;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
