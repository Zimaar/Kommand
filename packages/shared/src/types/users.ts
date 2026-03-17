import type { ChannelType } from './messages';

export type UserPlan = 'trial' | 'starter' | 'growth' | 'pro';
export type StorePlatform = 'shopify' | 'woocommerce' | 'bigcommerce';
export type AccountingPlatform = 'xero' | 'quickbooks' | 'freshbooks';

export interface User {
  readonly id: string;
  readonly clerkId: string;
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
  readonly timezone: string;
  readonly morningBrief?: string;
  readonly plan: UserPlan;
  readonly planExpiresAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Store {
  readonly id: string;
  readonly userId: string;
  readonly platform: StorePlatform;
  readonly shopDomain: string;
  readonly shopName?: string;
  readonly accessToken: string;
  readonly tokenIv: string;
  readonly scopes?: string[];
  readonly isActive: boolean;
  readonly installedAt: Date;
  readonly lastSyncedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AccountingConnection {
  readonly id: string;
  readonly userId: string;
  readonly platform: AccountingPlatform;
  readonly tenantId?: string;
  readonly tenantName?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenIv: string;
  readonly tokenExpiresAt?: Date;
  readonly scopes?: string[];
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Channel {
  readonly id: string;
  readonly userId: string;
  readonly type: ChannelType;
  readonly channelId: string;
  readonly config: Record<string, unknown>;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
