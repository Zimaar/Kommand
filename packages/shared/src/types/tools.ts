export type ToolPlatform = 'shopify' | 'xero' | 'quickbooks' | 'stripe' | 'internal';
export type ConfirmationTier = 0 | 1 | 2 | 3;

export enum ConfirmationTierEnum {
  NONE = 0,
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
}

export interface ToolContext {
  readonly userId: string;
  readonly storeId?: string;
  readonly connectionId?: string;
  readonly currency: string;
  readonly timezone: string;
}

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly display?: string;
  readonly error?: string;
}

export type ToolHandler = (params: unknown, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly confirmationTier: ConfirmationTier;
  readonly platform: ToolPlatform;
  readonly handler: ToolHandler;
}
