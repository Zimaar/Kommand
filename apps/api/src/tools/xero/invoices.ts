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
  LineItemID?: string;
  Description: string;
  Quantity: number;
  UnitAmount: number;
  LineAmount: number;
  AccountCode?: string;
}

type XeroInvoiceStatus = 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: 'ACCREC' | 'ACCPAY';
  Status: XeroInvoiceStatus;
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

interface XeroInvoicesResponse {
  Invoices: XeroInvoice[];
}

interface XeroContactsResponse {
  Contacts: XeroContact[];
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Xero returns dates as "/Date(timestamp)/" or "YYYY-MM-DD".
 * Returns a JS Date in either case.
 */
function parseXeroDate(raw: string): Date {
  const match = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(raw);
  if (match) return new Date(parseInt(match[1]!, 10));
  // ISO or YYYY-MM-DD
  return new Date(raw);
}

function formatDate(raw: string): string {
  const d = parseXeroDate(raw);
  return d.toISOString().slice(0, 10);
}

function daysOverdue(dueDateRaw: string): number {
  const due = parseXeroDate(dueDateRaw);
  const now = new Date();
  // Reset time to midnight for whole-day comparison
  due.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / 86_400_000));
}

function isOverdue(dueDateRaw: string, status: XeroInvoiceStatus): boolean {
  return status === 'AUTHORISED' && daysOverdue(dueDateRaw) > 0;
}

// Format a Xero date for PUT /Invoices body (ISO 8601 YYYY-MM-DD)
function toXeroDateParam(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch all AUTHORISED invoices across all pages (Xero paginates at 100).
 * Used for client-side overdue filtering where skipping pages would miss data.
 */
async function fetchAllAuthorisedInvoices(
  client: Awaited<ReturnType<typeof getXeroClient>>
): Promise<XeroInvoice[]> {
  const all: XeroInvoice[] = [];
  let page = 1;
  while (true) {
    const res = await client.get<XeroInvoicesResponse>(
      `/Invoices?Statuses=AUTHORISED&order=DueDate%20ASC&page=${page}`
    );
    const batch = res.Invoices;
    all.push(...batch);
    if (batch.length < 100) break; // Xero page size is 100; fewer means last page
    page++;
  }
  return all;
}

async function fetchInvoiceByNumber(
  client: Awaited<ReturnType<typeof getXeroClient>>,
  invoiceNumber: string
): Promise<XeroInvoice | null> {
  const res = await client.get<XeroInvoicesResponse>(
    `/Invoices?InvoiceNumbers=${encodeURIComponent(invoiceNumber)}`
  );
  return res.Invoices[0] ?? null;
}

// ─── Zod input schemas ────────────────────────────────────────────────────────

const InvoiceStatusEnum = z.enum(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'OVERDUE']);

const GetInvoicesInput = z.object({
  status: InvoiceStatusEnum.optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetInvoiceDetailsInput = z.object({
  invoice_number: z.string().min(1),
});

const LineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit_amount: z.number().positive(),
});

const CreateInvoiceInput = z.object({
  contact_name: z.string().min(1),
  line_items: z.array(LineItemSchema).min(1),
  due_date: z.string().optional(), // YYYY-MM-DD
  reference: z.string().optional(),
});

const SendInvoiceInput = z.object({
  invoice_number: z.string().min(1),
});

const SendInvoiceReminderInput = z.object({
  invoice_number: z.string().min(1),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

function makeGetInvoices() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetInvoicesInput.parse(params);
    const client = await getXeroClient(context.userId);

    // OVERDUE is not a native Xero filter status — paginate all AUTHORISED and filter client-side
    let invoices: XeroInvoice[];
    if (input.status === 'OVERDUE') {
      invoices = (await fetchAllAuthorisedInvoices(client)).filter((inv) =>
        isOverdue(inv.DueDate, inv.Status)
      );
    } else if (input.status) {
      const res = await client.get<XeroInvoicesResponse>(
        `/Invoices?Statuses=${input.status}&order=Date%20DESC&page=1`
      );
      invoices = res.Invoices;
    } else {
      // Default: show active invoices (DRAFT + AUTHORISED)
      const res = await client.get<XeroInvoicesResponse>(
        `/Invoices?Statuses=DRAFT,SUBMITTED,AUTHORISED&order=Date%20DESC&page=1`
      );
      invoices = res.Invoices;
    }

    const data = invoices.slice(0, input.limit).map((inv) => ({
      invoiceNumber: inv.InvoiceNumber,
      contactName: inv.Contact.Name,
      total: round2(inv.Total),
      amountDue: round2(inv.AmountDue),
      status: inv.Status,
      dueDate: formatDate(inv.DueDate),
      isOverdue: isOverdue(inv.DueDate, inv.Status),
    }));

    return { success: true, data };
  };
}

function makeGetInvoiceDetails() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = GetInvoiceDetailsInput.parse(params);
    const client = await getXeroClient(context.userId);

    const inv = await fetchInvoiceByNumber(client, input.invoice_number);
    if (!inv) {
      return { success: false, error: `Invoice ${input.invoice_number} not found` };
    }

    const data = {
      invoiceId: inv.InvoiceID,
      invoiceNumber: inv.InvoiceNumber,
      status: inv.Status,
      contactName: inv.Contact.Name,
      contactEmail: inv.Contact.EmailAddress ?? null,
      date: formatDate(inv.Date),
      dueDate: formatDate(inv.DueDate),
      reference: inv.Reference ?? null,
      subTotal: round2(inv.SubTotal),
      totalTax: round2(inv.TotalTax),
      total: round2(inv.Total),
      amountDue: round2(inv.AmountDue),
      amountPaid: round2(inv.AmountPaid),
      isOverdue: isOverdue(inv.DueDate, inv.Status),
      daysOverdue: isOverdue(inv.DueDate, inv.Status) ? daysOverdue(inv.DueDate) : 0,
      lineItems: inv.LineItems.map((li) => ({
        description: li.Description,
        quantity: li.Quantity,
        unitAmount: round2(li.UnitAmount),
        lineAmount: round2(li.LineAmount),
      })),
    };

    return { success: true, data };
  };
}

function makeCreateInvoice() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = CreateInvoiceInput.parse(params);
    const client = await getXeroClient(context.userId);

    // 1. Find the contact by name (case-insensitive search)
    const contactRes = await client.get<XeroContactsResponse>(
      `/Contacts?searchTerm=${encodeURIComponent(input.contact_name)}&includeArchived=false`
    );

    if (contactRes.Contacts.length === 0) {
      return {
        success: false,
        error: `Contact "${input.contact_name}" not found in Xero. Create the contact first.`,
      };
    }

    // Prefer an exact name match (case-insensitive) to avoid fuzzy-match ambiguity
    const exactMatch = contactRes.Contacts.find(
      (c) => c.Name.toLowerCase() === input.contact_name.toLowerCase()
    );

    if (!exactMatch && contactRes.Contacts.length > 1) {
      const names = contactRes.Contacts.slice(0, 5).map((c) => `"${c.Name}"`).join(', ');
      return {
        success: false,
        error: `Multiple contacts match "${input.contact_name}": ${names}. Please use the exact contact name.`,
      };
    }

    const contact = exactMatch ?? contactRes.Contacts[0]!;

    // 2. Build the invoice payload
    const lineItems = input.line_items.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unit_amount,
    }));

    const total = round2(
      input.line_items.reduce((sum, li) => sum + li.quantity * li.unit_amount, 0)
    );

    const invoiceBody: Record<string, unknown> = {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: { ContactID: contact.ContactID },
          Status: 'DRAFT',
          LineAmountTypes: 'EXCLUSIVE',
          LineItems: lineItems,
          ...(input.due_date ? { DueDate: toXeroDateParam(input.due_date) } : {}),
          ...(input.reference ? { Reference: input.reference } : {}),
        },
      ],
    };

    // 3. Create via PUT /Invoices
    const createRes = await client.put<XeroInvoicesResponse>('/Invoices', invoiceBody);
    const created = createRes.Invoices[0];

    if (!created) {
      return { success: false, error: 'Xero did not return the created invoice' };
    }

    return {
      success: true,
      data: {
        invoiceId: created.InvoiceID,
        invoiceNumber: created.InvoiceNumber,
        contactName: contact.Name,
        total: round2(created.Total || total),
        itemCount: input.line_items.length,
        dueDate: created.DueDate ? formatDate(created.DueDate) : null,
        status: created.Status,
      },
      display: `Created draft invoice ${created.InvoiceNumber} for ${contact.Name} — ${context.currency} ${(created.Total || total).toFixed(2)} (${input.line_items.length} item${input.line_items.length !== 1 ? 's' : ''})`,
    };
  };
}

function makeSendInvoice() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = SendInvoiceInput.parse(params);
    const client = await getXeroClient(context.userId);

    const inv = await fetchInvoiceByNumber(client, input.invoice_number);
    if (!inv) {
      return { success: false, error: `Invoice ${input.invoice_number} not found` };
    }

    if (inv.Type !== 'ACCREC') {
      return {
        success: false,
        error: `"${input.invoice_number}" is a bill (accounts payable), not a sales invoice. Use approve_bill instead.`,
      };
    }

    if (inv.Status === 'DRAFT' || inv.Status === 'SUBMITTED') {
      return {
        success: false,
        error: `Invoice ${input.invoice_number} is in ${inv.Status} status and cannot be sent. Approve it first.`,
      };
    }

    if (inv.Status === 'PAID') {
      return { success: false, error: `Invoice ${input.invoice_number} is already paid` };
    }

    if (inv.Status === 'VOIDED' || inv.Status === 'DELETED') {
      return { success: false, error: `Invoice ${input.invoice_number} has been ${inv.Status.toLowerCase()} and cannot be sent` };
    }

    // POST /Invoices/{InvoiceID}/Email — empty body sends the invoice email
    await client.post(`/Invoices/${inv.InvoiceID}/Email`, {});

    return {
      success: true,
      data: {
        invoiceNumber: inv.InvoiceNumber,
        contactName: inv.Contact.Name,
        contactEmail: inv.Contact.EmailAddress ?? null,
        total: round2(inv.Total),
        amountDue: round2(inv.AmountDue),
      },
      display: `Sent invoice ${inv.InvoiceNumber} to ${inv.Contact.Name}${inv.Contact.EmailAddress ? ` (${inv.Contact.EmailAddress})` : ''}`,
    };
  };
}

function makeGetOverdueInvoices() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    void params; // no inputs
    const client = await getXeroClient(context.userId);

    // Paginate all AUTHORISED invoices (Xero max 100/page) before filtering client-side
    const allAuthorised = await fetchAllAuthorisedInvoices(client);
    const overdue = allAuthorised.filter((inv) => isOverdue(inv.DueDate, inv.Status) && inv.AmountDue > 0);

    // Sort by AmountDue descending (largest first)
    overdue.sort((a, b) => b.AmountDue - a.AmountDue);

    const data = overdue.map((inv) => ({
      invoiceNumber: inv.InvoiceNumber,
      contactName: inv.Contact.Name,
      total: round2(inv.Total),
      amountDue: round2(inv.AmountDue),
      dueDate: formatDate(inv.DueDate),
      daysOverdue: daysOverdue(inv.DueDate),
    }));

    const totalOverdue = round2(data.reduce((sum, inv) => sum + inv.amountDue, 0));

    return {
      success: true,
      data: {
        invoices: data,
        count: data.length,
        totalAmountDue: totalOverdue,
        currency: context.currency,
      },
    };
  };
}

function makeSendInvoiceReminder() {
  return async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const input = SendInvoiceReminderInput.parse(params);
    const client = await getXeroClient(context.userId);

    const inv = await fetchInvoiceByNumber(client, input.invoice_number);
    if (!inv) {
      return { success: false, error: `Invoice ${input.invoice_number} not found` };
    }

    if (inv.Status !== 'AUTHORISED') {
      return {
        success: false,
        error: `Invoice ${input.invoice_number} is not an outstanding invoice (status: ${inv.Status})`,
      };
    }

    if (!isOverdue(inv.DueDate, inv.Status)) {
      return {
        success: false,
        error: `Invoice ${input.invoice_number} is not overdue yet (due ${formatDate(inv.DueDate)})`,
      };
    }

    const days = daysOverdue(inv.DueDate);

    await client.post(`/Invoices/${inv.InvoiceID}/Email`, {});

    return {
      success: true,
      data: {
        invoiceNumber: inv.InvoiceNumber,
        contactName: inv.Contact.Name,
        contactEmail: inv.Contact.EmailAddress ?? null,
        amountDue: round2(inv.AmountDue),
        daysOverdue: days,
        dueDate: formatDate(inv.DueDate),
      },
      display: `Sent payment reminder for invoice ${inv.InvoiceNumber} to ${inv.Contact.Name} — ${context.currency} ${round2(inv.AmountDue).toFixed(2)} overdue by ${days} day${days !== 1 ? 's' : ''}`,
    };
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerXeroInvoiceTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_invoices',
    description:
      'List Xero invoices filtered by status. Use when the merchant asks to see invoices, outstanding bills, or payments. Defaults to showing DRAFT, SUBMITTED and AUTHORISED invoices.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        status: {
          type: 'string',
          enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'OVERDUE'],
          description: 'Filter invoices by status. Omit to see all active invoices.',
        },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
      },
      required: [],
    },
    handler: makeGetInvoices(),
  });

  registry.register({
    name: 'get_invoice_details',
    description:
      'Get full details of a single Xero invoice including all line items, amounts and payment status. Use when the merchant asks about a specific invoice number.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {
        invoice_number: { type: 'string', description: 'Invoice number e.g. "INV-0042"' },
      },
      required: ['invoice_number'],
    },
    handler: makeGetInvoiceDetails(),
  });

  registry.register({
    name: 'create_invoice',
    description:
      'Create a new draft invoice in Xero for a contact. Use when the merchant asks to create or raise an invoice. Requires confirmation (tier 1). The contact must already exist in Xero.',
    platform: 'xero',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        contact_name: {
          type: 'string',
          description: 'Name of the Xero contact to invoice',
        },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number', minimum: 0.01 },
              unit_amount: { type: 'number', minimum: 0.01 },
            },
            required: ['description', 'quantity', 'unit_amount'],
          },
          minItems: 1,
          description: 'Line items for the invoice',
        },
        due_date: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format. Defaults to Xero default terms.',
        },
        reference: {
          type: 'string',
          description: 'Optional reference or PO number',
        },
      },
      required: ['contact_name', 'line_items'],
    },
    handler: makeCreateInvoice(),
  });

  registry.register({
    name: 'send_invoice',
    description:
      'Send an approved Xero invoice to the contact by email. Use when the merchant asks to send or email an invoice. Requires confirmation (tier 1). Invoice must be in AUTHORISED status.',
    platform: 'xero',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        invoice_number: { type: 'string', description: 'Invoice number e.g. "INV-0042"' },
      },
      required: ['invoice_number'],
    },
    handler: makeSendInvoice(),
  });

  registry.register({
    name: 'get_overdue_invoices',
    description:
      'Get all outstanding invoices that are past their due date, sorted by amount (largest first). Use when the merchant asks about overdue invoices, unpaid bills, or what money is owed.',
    platform: 'xero',
    confirmationTier: 0,
    inputSchema: {
      properties: {},
      required: [],
    },
    handler: makeGetOverdueInvoices(),
  });

  registry.register({
    name: 'send_invoice_reminder',
    description:
      'Send a payment reminder email for an overdue Xero invoice. Use when the merchant asks to chase a payment or send a reminder. Requires confirmation (tier 1). Invoice must be overdue.',
    platform: 'xero',
    confirmationTier: 1,
    inputSchema: {
      properties: {
        invoice_number: { type: 'string', description: 'Invoice number e.g. "INV-0042"' },
      },
      required: ['invoice_number'],
    },
    handler: makeSendInvoiceReminder(),
  });
}
