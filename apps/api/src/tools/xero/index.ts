import type { ToolRegistry } from '../../core/tool-registry.js';
import { registerXeroInvoiceTools } from './invoices.js';

export { getXeroClient } from './client.js';

export function registerAllXeroTools(registry: ToolRegistry): void {
  registerXeroInvoiceTools(registry);
}
