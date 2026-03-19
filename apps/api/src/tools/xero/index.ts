import type { ToolRegistry } from '../../core/tool-registry.js';
import { registerXeroInvoiceTools } from './invoices.js';
import { registerXeroBillTools } from './bills.js';
import { registerXeroReportTools } from './reports.js';

export { getXeroClient } from './client.js';

export function registerAllXeroTools(registry: ToolRegistry): void {
  registerXeroInvoiceTools(registry);
  registerXeroBillTools(registry);
  registerXeroReportTools(registry);
}
