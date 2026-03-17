import { z } from 'zod';

const ToolPlatformSchema = z.enum(['shopify', 'xero', 'quickbooks', 'stripe', 'internal']);

export const ToolContextSchema = z.object({
  userId: z.string(),
  storeId: z.string().optional(),
  connectionId: z.string().optional(),
  currency: z.string(),
  timezone: z.string(),
});

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  display: z.string().optional(),
  error: z.string().optional(),
});

export type ToolContextType = z.infer<typeof ToolContextSchema>;
export type ToolResultType = z.infer<typeof ToolResultSchema>;
