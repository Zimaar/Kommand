import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getXeroClient } from './client.js';
import { getDateRange } from './bills.js';

// ─── Xero Reports API types ───────────────────────────────────────────────────

interface XeroReportCell {
  Value: string;
  Attributes?: Array<{ Value: string; Id: string }>;
}

interface XeroReportRow {
  RowType: 'Header' | 'Section' | 'Row' | 'SummaryRow';
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
}

interface XeroReport {
  ReportID: string;
  ReportName: string;
  ReportDate?: string;
  Rows: XeroReportRow[];
}

interface XeroReportsResponse {
  Reports: XeroReport[];
}

// Accounts endpoint (used for bank balances)
interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  BankAccountNumber?: string;
  CurrencyCode?: string;
  CurrentBalance: number;
  Status: string;
}

interface XeroAccountsResponse {
  Accounts: XeroAccount[];
}

// Invoice types (for AR aging — reuses the ACCREC pattern from invoices.ts)
interface XeroARInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Contact: { Name: string };
  AmountDue: number;
  DueDate: string;
  Status: string;
}

interface XeroARResponse {
  Invoices: XeroARInvoice[];
}

// ─── Report parsing helpers ───────────────────────────────────────────────────

/**
 * Parse a Xero amount string to a number.
 * Handles: "10,000.00", "(1,234.56)" (negative), "", "N/A"
 */
function parseAmount(value: string): number {
  if (!value || value === 'N/A') return 0;
  const isNeg = value.startsWith('(') && value.endsWith(')');
  const cleaned = value.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned) || 0;
  return isNeg ? -n : n;
}

/**
 * Extract the numeric value from the last cell of a row
 * (Xero puts the data value in the last column; earlier columns are labels or comparisons).
 */
function lastCellAmount(cells: XeroReportCell[] | undefined): number {
  if (!cells || cells.length === 0) return 0;
  return parseAmount(cells[cells.length - 1]!.Value);
}

/**
 * Find a top-level section by title (case-insensitive partial match),
 * then return the value of its SummaryRow.
 */
function sectionTotal(rows: XeroReportRow[], ...titleFragments: string[]): number {
  for (const row of rows) {
    if (row.RowType !== 'Section') continue;
    const title = (row.Title ?? '').toLowerCase();
    if (titleFragments.some((f) => title.includes(f.toLowerCase()))) {
      const summary = row.Rows?.find((r) => r.RowType === 'SummaryRow');
      return lastCellAmount(summary?.Cells);
    }
  }
  return 0;
}

/**
 * Sum all top-level SummaryRow values matching a title fragment.
 * Used for balance sheet where "Assets" may have sub-sections each with their own SummaryRow.
 */
function sumNestedSections(rows: XeroReportRow[], ...titleFragments: string[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.RowType !== 'Section') continue;
    const title = (row.Title ?? '').toLowerCase();
    if (!titleFragments.some((f) => title.includes(f.toLowerCase()))) continue;
    // A section may have a direct SummaryRow or nested sub-sections
    for (const child of row.Rows ?? []) {
      if (child.RowType === 'SummaryRow') {
        total += lastCellAmount(child.Cells);
      }
    }
  }
  return total;
}

/**
 * Find the last root-level SummaryRow (typically "Net Profit" or "Net Assets").
 */
function rootSummaryAmount(rows: XeroReportRow[]): number {
  const summaries = rows.filter((r) => r.RowType === 'SummaryRow');
  const last = summaries[summaries.length - 1];
  return lastCellAmount(last?.Cells);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseXeroDate(raw: string): Date {
  const match = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(raw);
  if (match) return new Date(parseInt(match[1]!, 10));
  return new Date(raw);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Date range logic shared with bills.ts via getDateRange

// ─── Zod input schemas ────────────────────────────────────────────────────────

const ReportPeriodEnum = z.enum([
  'this_month',
  'last_month',
  'last_30_days',
  'last_90_days',
  'this_year',
]);

const GetProfitLossInput = z.object({
  period: ReportPeriodEnum.default('this_month'),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeGetProfitLoss() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetProfitLossInput.parse(params);
    const client = await getXeroClient(context.userId);

    const { fromDate, toDate } = getDateRange(input.period);
    const res = await client.get<XeroReportsResponse>(
      `/Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}&standardLayout=true&paymentsOnly=false`
    );

    const report = res.Reports[0];
    if (!report) {
      return { success: false, error: 'Xero did not return a Profit & Loss report' };
    }

    const rows = report.Rows;

    // Extract key line items — section titles vary by Xero region/settings so
    // we match on multiple possible fragments per section type.
    const income = sectionTotal(rows, 'income', 'revenue', 'trading income');
    const cogs = sectionTotal(rows, 'cost of sales', 'cost of goods', 'direct costs');
    const grossProfit = income - cogs;

    // Operating expenses: look for any section titled "operating", "expenses", "overhead"
    // Sum all matching sections (some setups split into multiple)
    let opex = 0;
    for (const row of rows) {
      if (row.RowType !== 'Section') continue;
      const title = (row.Title ?? '').toLowerCase();
      if (
        title.includes('operating') ||
        title.includes('overhead') ||
        (title.includes('expense') && !title.includes('income'))
      ) {
        const summary = row.Rows?.find((r) => r.RowType === 'SummaryRow');
        opex += lastCellAmount(summary?.Cells);
      }
    }

    // Net profit = last root-level SummaryRow (most reliable)
    const netProfit = rootSummaryAmount(rows);

    // Fallback: if parsing produced zeros for income, surface raw section data
    const sections: Record<string, number> = {};
    for (const row of rows) {
      if (row.RowType === 'Section' && row.Title) {
        const summary = row.Rows?.find((r) => r.RowType === 'SummaryRow');
        if (summary) {
          const val = lastCellAmount(summary.Cells);
          if (val !== 0) sections[row.Title] = round2(val);
        }
      }
    }

    return {
      success: true,
      data: {
        period: input.period,
        fromDate,
        toDate,
        currency: context.currency,
        income: round2(income),
        costOfSales: round2(cogs),
        grossProfit: round2(grossProfit),
        operatingExpenses: round2(opex),
        netProfit: round2(netProfit),
        sections, // raw section totals for transparency
      },
    };
  };
}

function makeGetBalanceSheet() {
  return async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
    const client = await getXeroClient(context.userId);

    // Point-in-time snapshot — today's date
    const toDate = new Date().toISOString().slice(0, 10);
    const res = await client.get<XeroReportsResponse>(
      `/Reports/BalanceSheet?date=${toDate}&standardLayout=true`
    );

    const report = res.Reports[0];
    if (!report) {
      return { success: false, error: 'Xero did not return a Balance Sheet report' };
    }

    const rows = report.Rows;

    // Standard balance sheet sections
    // Prefer an exact "Assets" parent section (nested layout) to avoid double-counting
    // "Bank" as both a standalone section and under "Current Assets" in flat layouts.
    const assetsSection = rows.find(
      (r) => r.RowType === 'Section' && (r.Title ?? '').toLowerCase().trim() === 'assets'
    );
    const totalAssets = assetsSection
      ? lastCellAmount(assetsSection.Rows?.find((r) => r.RowType === 'SummaryRow')?.Cells)
      : sumNestedSections(rows, 'asset', 'bank', 'fixed');
    const totalLiabilities = sumNestedSections(rows, 'liabilit');
    const totalEquity = sumNestedSections(rows, 'equity', 'capital', 'retained');

    // Build raw section map for transparency
    const sections: Record<string, number> = {};
    for (const row of rows) {
      if (row.RowType === 'Section' && row.Title) {
        const summary = row.Rows?.find((r) => r.RowType === 'SummaryRow');
        if (summary) {
          const val = lastCellAmount(summary.Cells);
          if (val !== 0) sections[row.Title] = round2(val);
        }
      }
    }

    // Net assets = root summary (should equal equity)
    const netAssets = rootSummaryAmount(rows);

    return {
      success: true,
      data: {
        asOf: toDate,
        currency: context.currency,
        totalAssets: round2(totalAssets),
        totalLiabilities: round2(totalLiabilities),
        totalEquity: round2(totalEquity),
        netAssets: round2(netAssets),
        sections,
      },
    };
  };
}

function makeGetAccountsReceivable() {
  return async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
    const client = await getXeroClient(context.userId);

    // Fetch all AUTHORISED ACCREC invoices (outstanding AR) — paginate
    const all: XeroARInvoice[] = [];
    let page = 1;
    while (true) {
      const res = await client.get<XeroARResponse>(
        `/Invoices?Type=ACCREC&Statuses=AUTHORISED&order=DueDate%20ASC&page=${page}`
      );
      all.push(...res.Invoices);
      if (res.Invoices.length < 100) break;
      page++;
    }

    const outstanding = all.filter((inv) => inv.AmountDue > 0);

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const buckets = {
      current: 0,      // not yet due
      days1to30: 0,    // 1–30 days overdue
      days31to60: 0,   // 31–60 days overdue
      days61to90: 0,   // 61–90 days overdue
      days91plus: 0,   // 91+ days overdue
    };

    const invoiceList = outstanding.map((inv) => {
      const due = parseXeroDate(inv.DueDate);
      due.setHours(0, 0, 0, 0);
      const daysOverdue = Math.round((now.getTime() - due.getTime()) / 86_400_000);

      if (daysOverdue <= 0) buckets.current += inv.AmountDue;
      else if (daysOverdue <= 30) buckets.days1to30 += inv.AmountDue;
      else if (daysOverdue <= 60) buckets.days31to60 += inv.AmountDue;
      else if (daysOverdue <= 90) buckets.days61to90 += inv.AmountDue;
      else buckets.days91plus += inv.AmountDue;

      return {
        invoiceNumber: inv.InvoiceNumber,
        contactName: inv.Contact.Name,
        amountDue: round2(inv.AmountDue),
        dueDate: parseXeroDate(inv.DueDate).toISOString().slice(0, 10),
        daysOverdue: Math.max(0, daysOverdue),
      };
    });

    const totalAR = round2(outstanding.reduce((sum, inv) => sum + inv.AmountDue, 0));
    const overdueTotal = round2(
      buckets.days1to30 + buckets.days31to60 + buckets.days61to90 + buckets.days91plus
    );

    return {
      success: true,
      data: {
        asOf: now.toISOString().slice(0, 10),
        currency: context.currency,
        totalOutstanding: totalAR,
        overdueTotal,
        count: outstanding.length,
        aging: {
          current: round2(buckets.current),
          '1-30 days': round2(buckets.days1to30),
          '31-60 days': round2(buckets.days31to60),
          '61-90 days': round2(buckets.days61to90),
          '91+ days': round2(buckets.days91plus),
        },
        invoices: invoiceList.sort((a, b) => b.amountDue - a.amountDue),
      },
    };
  };
}

function makeGetCashSummary() {
  return async (_params: unknown, context: ToolContext): Promise<ToolResult> => {
    const client = await getXeroClient(context.userId);

    // GET /Accounts?where=Type=="BANK" — returns all bank accounts with CurrentBalance
    const res = await client.get<XeroAccountsResponse>(
      `/Accounts?where=Type%3D%3D%22BANK%22&includeArchived=false`
    );

    const accounts = res.Accounts.filter((a) => a.Status === 'ACTIVE');

    const totalCash = round2(accounts.reduce((sum, a) => sum + (a.CurrentBalance ?? 0), 0));

    const data = accounts
      .sort((a, b) => (b.CurrentBalance ?? 0) - (a.CurrentBalance ?? 0))
      .map((a) => ({
        accountName: a.Name,
        accountNumber: a.BankAccountNumber ?? null,
        currency: a.CurrencyCode ?? context.currency,
        balance: round2(a.CurrentBalance ?? 0),
      }));

    return {
      success: true,
      data: {
        asOf: new Date().toISOString().slice(0, 10),
        currency: context.currency,
        totalCash,
        accountCount: data.length,
        accounts: data,
      },
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerXeroReportTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_profit_loss',
    description:
      'Get a Profit & Loss (income statement) summary from Xero for a time period. Use when the merchant asks about profit, loss, revenue, income, expenses, or financial performance. Returns income, cost of sales, gross profit, operating expenses, and net profit.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        period: {
          type: 'string',
          enum: ['this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_year'],
          default: 'this_month',
        },
      },
      required: [],
    },
    handler: makeGetProfitLoss(),
  });

  registry.register({
    name: 'get_balance_sheet',
    description:
      "Get the current Balance Sheet from Xero showing total assets, liabilities, and equity as of today. Use when the merchant asks about financial position, net worth, what the business owns or owes at a high level.",
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {},
      required: [],
    },
    handler: makeGetBalanceSheet(),
  });

  registry.register({
    name: 'get_accounts_receivable',
    description:
      'Get all outstanding sales invoices from Xero with aging buckets (current, 1-30, 31-60, 61-90, 90+ days overdue). Use when the merchant asks about money owed to them, outstanding payments, AR aging, or who owes what.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {},
      required: [],
    },
    handler: makeGetAccountsReceivable(),
  });

  registry.register({
    name: 'get_cash_summary',
    description:
      'Get current cash balances across all bank accounts in Xero. Use when the merchant asks about cash position, bank balance, how much cash they have, or liquidity.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {},
      required: [],
    },
    handler: makeGetCashSummary(),
  });
}
