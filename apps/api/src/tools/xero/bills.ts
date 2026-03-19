import { z } from 'zod';
import type { ToolContext, ToolResult } from '@kommand/shared';
import type { ToolRegistry } from '../../core/tool-registry.js';
import { getXeroClient } from './client.js';

// ─── Xero API types ───────────────────────────────────────────────────────────

interface XeroContact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
}

interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  LineAmount: number;
  AccountCode?: string;
}

type XeroBillStatus = 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';

interface XeroBill {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: 'ACCPAY';
  Status: XeroBillStatus;
  Contact: XeroContact;
  Total: number;
  SubTotal: number;
  TotalTax: number;
  AmountDue: number;
  AmountPaid: number;
  Date: string;
  DueDate: string;
  Reference?: string;
  LineItems: XeroLineItem[];
}

interface XeroBillsResponse {
  Invoices: XeroBill[];
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseXeroDate(raw: string): Date {
  const match = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(raw);
  if (match) return new Date(parseInt(match[1]!, 10));
  return new Date(raw);
}

function formatDate(raw: string): string {
  return parseXeroDate(raw).toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Days until due: negative means overdue */
function daysUntilDue(dueDateRaw: string): number {
  const due = parseXeroDate(dueDateRaw);
  const now = new Date();
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}

type ExpensePeriod = 'this_month' | 'last_month' | 'last_30_days' | 'last_90_days' | 'this_year';

/** Returns { fromDate, toDate } as YYYY-MM-DD strings for the given period */
function getExpenseDateRange(period: ExpensePeriod): { fromDate: string; toDate: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  switch (period) {
    case 'this_month': {
      const start = new Date(Date.UTC(y, m, 1));
      return { fromDate: iso(start), toDate: iso(now) };
    }
    case 'last_month': {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0)); // last day of prev month
      return { fromDate: iso(start), toDate: iso(end) };
    }
    case 'last_30_days': {
      const start = new Date(Date.UTC(y, m, now.getUTCDate() - 30));
      return { fromDate: iso(start), toDate: iso(now) };
    }
    case 'last_90_days': {
      const start = new Date(Date.UTC(y, m, now.getUTCDate() - 90));
      return { fromDate: iso(start), toDate: iso(now) };
    }
    case 'this_year': {
      const start = new Date(Date.UTC(y, 0, 1));
      return { fromDate: iso(start), toDate: iso(now) };
    }
  }
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

/**
 * Paginate ACCPAY bills matching given Statuses and optional date range.
 * Xero pages at 100 records; keeps fetching until a page returns < 100.
 */
async function fetchBills(
  client: Awaited<ReturnType<typeof getXeroClient>>,
  statuses: string,
  opts: { fromDate?: string; toDate?: string; order?: string } = {}
): Promise<XeroBill[]> {
  const all: XeroBill[] = [];
  let page = 1;
  const order = opts.order ?? 'DueDate ASC';
  const dateParams = [
    opts.fromDate ? `fromDate=${opts.fromDate}` : '',
    opts.toDate ? `toDate=${opts.toDate}` : '',
  ]
    .filter(Boolean)
    .join('&');

  while (true) {
    const qs = [
      `Type=ACCPAY`,
      `Statuses=${statuses}`,
      `order=${encodeURIComponent(order)}`,
      `page=${page}`,
      dateParams,
    ]
      .filter(Boolean)
      .join('&');

    const res = await client.get<XeroBillsResponse>(`/Invoices?${qs}`);
    all.push(...res.Invoices);
    if (res.Invoices.length < 100) break;
    page++;
  }
  return all;
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const GetBillsDueInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

const ApproveBillInput = z.object({
  bill_id: z.string().min(1).describe('Invoice number (e.g. "BILL-0042") or Xero InvoiceID'),
});

const ExpensePeriodEnum = z.enum([
  'this_month',
  'last_month',
  'last_30_days',
  'last_90_days',
  'this_year',
]);

const GetExpenseSummaryInput = z.object({
  period: ExpensePeriodEnum.default('last_30_days'),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeGetBillsDue() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetBillsDueInput.parse(params);
    const client = await getXeroClient(context.userId);

    // Fetch all AUTHORISED + SUBMITTED bills (unpaid, awaiting payment/approval)
    const bills = await fetchBills(client, 'AUTHORISED,SUBMITTED');

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const cutoff = new Date(now.getTime() + input.days * 86_400_000);

    // Include bills due within the window AND any that are already overdue
    const upcoming = bills.filter((b) => {
      const due = parseXeroDate(b.DueDate);
      due.setHours(0, 0, 0, 0);
      return due <= cutoff && b.AmountDue > 0;
    });

    // Sort: overdue first (ascending DueDate so oldest overdue comes first)
    upcoming.sort((a, b) => {
      const da = parseXeroDate(a.DueDate).getTime();
      const db = parseXeroDate(b.DueDate).getTime();
      return da - db;
    });

    const totalDue = round2(upcoming.reduce((sum, b) => sum + b.AmountDue, 0));
    const overdueBills = upcoming.filter((b) => daysUntilDue(b.DueDate) < 0);

    const data = upcoming.map((b) => {
      const days = daysUntilDue(b.DueDate);
      return {
        billNumber: b.InvoiceNumber,
        supplierName: b.Contact.Name,
        total: round2(b.Total),
        amountDue: round2(b.AmountDue),
        status: b.Status,
        dueDate: formatDate(b.DueDate),
        daysUntilDue: days,
        isOverdue: days < 0,
      };
    });

    return {
      success: true,
      data: {
        bills: data,
        count: data.length,
        overdueCount: overdueBills.length,
        totalAmountDue: totalDue,
        currency: context.currency,
        lookAheadDays: input.days,
      },
    };
  };
}

function makeApproveBill() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    void context;
    const input = ApproveBillInput.parse(params);
    const client = await getXeroClient(context.userId);

    // Look up the bill — supports both invoice number and InvoiceID (UUID)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.bill_id
    );

    let bill: XeroBill | null;
    if (isUuid) {
      const res = await client.get<XeroBillsResponse>(`/Invoices/${input.bill_id}`);
      bill = res.Invoices[0] ?? null;
    } else {
      const res = await client.get<XeroBillsResponse>(
        `/Invoices?InvoiceNumbers=${encodeURIComponent(input.bill_id)}&Type=ACCPAY`
      );
      bill = res.Invoices[0] ?? null;
    }

    if (!bill) {
      return { success: false, error: `Bill "${input.bill_id}" not found` };
    }

    if (bill.Type !== 'ACCPAY') {
      return {
        success: false,
        error: `"${input.bill_id}" is not a bill (it's a sales invoice). Use send_invoice instead.`,
      };
    }

    if (bill.Status === 'AUTHORISED') {
      return {
        success: false,
        error: `Bill ${bill.InvoiceNumber} is already approved (AUTHORISED)`,
      };
    }

    if (bill.Status === 'PAID') {
      return { success: false, error: `Bill ${bill.InvoiceNumber} is already paid` };
    }

    if (bill.Status === 'VOIDED' || bill.Status === 'DELETED') {
      return {
        success: false,
        error: `Bill ${bill.InvoiceNumber} has been ${bill.Status.toLowerCase()} and cannot be approved`,
      };
    }

    // Approve: POST /Invoices/{InvoiceID} with Status=AUTHORISED
    const updated = await client.post<XeroBillsResponse>(`/Invoices/${bill.InvoiceID}`, {
      Status: 'AUTHORISED',
    });

    const approvedBill = updated.Invoices[0];

    return {
      success: true,
      data: {
        billNumber: bill.InvoiceNumber,
        supplierName: bill.Contact.Name,
        total: round2(bill.Total),
        amountDue: round2(bill.AmountDue),
        dueDate: bill.DueDate ? formatDate(bill.DueDate) : null,
        newStatus: approvedBill?.Status ?? 'AUTHORISED',
      },
      display: `Approved bill ${bill.InvoiceNumber} from ${bill.Contact.Name} — ${context.currency} ${round2(bill.Total).toFixed(2)}`,
    };
  };
}

function makeGetExpenseSummary() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetExpenseSummaryInput.parse(params);
    const client = await getXeroClient(context.userId);

    const { fromDate, toDate } = getExpenseDateRange(input.period);

    // Fetch PAID bills within the period (bills with payments recorded)
    // Also include AUTHORISED (approved, unpaid) to give a full accruals picture
    const bills = await fetchBills(client, 'PAID,AUTHORISED', {
      fromDate,
      toDate,
      order: 'Date DESC',
    });

    if (bills.length === 0) {
      return {
        success: true,
        data: {
          period: input.period,
          fromDate,
          toDate,
          totalExpenses: 0,
          currency: context.currency,
          bySupplier: [],
          billCount: 0,
        },
      };
    }

    // Group by supplier (Contact.Name), sum Total (pre-tax) and TotalTax
    const supplierMap = new Map<
      string,
      { total: number; tax: number; billCount: number }
    >();

    for (const bill of bills) {
      const name = bill.Contact.Name;
      const existing = supplierMap.get(name) ?? { total: 0, tax: 0, billCount: 0 };
      supplierMap.set(name, {
        total: existing.total + bill.Total,
        tax: existing.tax + bill.TotalTax,
        billCount: existing.billCount + 1,
      });
    }

    const grandTotal = round2(bills.reduce((sum, b) => sum + b.Total, 0));
    const grandTax = round2(bills.reduce((sum, b) => sum + b.TotalTax, 0));

    // Sort by total spend descending
    const bySupplier = Array.from(supplierMap.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([supplierName, stats]) => ({
        supplierName,
        total: round2(stats.total),
        tax: round2(stats.tax),
        billCount: stats.billCount,
        percentOfTotal:
          grandTotal > 0
            ? Math.round((stats.total / grandTotal) * 1000) / 10
            : 0,
      }));

    return {
      success: true,
      data: {
        period: input.period,
        fromDate,
        toDate,
        totalExpenses: grandTotal,
        totalTax: grandTax,
        currency: context.currency,
        billCount: bills.length,
        bySupplier,
      },
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerXeroBillTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_bills_due',
    description:
      'Get upcoming and overdue bills (accounts payable) from Xero. Use when the merchant asks about bills to pay, upcoming payments, or what they owe to suppliers. Shows bills due within the next N days plus any already overdue.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        days: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          default: 30,
          description: 'Look-ahead window in days (default 30). Also shows already-overdue bills.',
        },
      },
      required: [],
    },
    handler: makeGetBillsDue(),
  });

  registry.register({
    name: 'approve_bill',
    description:
      'Approve a Xero bill (accounts payable invoice) for payment by changing its status to AUTHORISED. Use when the merchant asks to approve, authorise, or sign off a bill. Requires confirmation (tier 1).',
    platform: 'xero',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        bill_id: {
          type: 'string',
          description: 'Bill invoice number (e.g. "BILL-0042") or Xero InvoiceID (UUID)',
        },
      },
      required: ['bill_id'],
    },
    handler: makeApproveBill(),
  });

  registry.register({
    name: 'get_expense_summary',
    description:
      'Get a categorized breakdown of business expenses (bills paid) from Xero for a time period, grouped by supplier. Use when the merchant asks about spending, expenses, costs, or what they paid to suppliers.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        period: {
          type: 'string',
          enum: ['this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_year'],
          default: 'last_30_days',
        },
      },
      required: [],
    },
    handler: makeGetExpenseSummary(),
  });
}
