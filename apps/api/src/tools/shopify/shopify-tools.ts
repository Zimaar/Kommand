import type { DB } from '../../db/connection.js';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { registerShopifyOrderTools } from './orders-read.js';
import { registerShopifyOrderWriteTools } from './orders-write.js';
import { registerShopifyProductTools } from './products.js';
import { registerShopifyCustomerTools } from './customers.js';
import { registerShopifyDiscountTools } from './discounts.js';
import { registerShopifyAnalyticsTools } from './analytics.js';

export function registerAllShopifyTools(db: DB, registry: ToolRegistry): void {
  registerShopifyOrderTools(db, registry);
  registerShopifyOrderWriteTools(db, registry);
  registerShopifyProductTools(db, registry);
  registerShopifyCustomerTools(db, registry);
  registerShopifyDiscountTools(db, registry);
  registerShopifyAnalyticsTools(db, registry);
}
