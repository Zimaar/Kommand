# AI BRAIN PROMPT — Technical Spec

> This is the most important file in the entire project. The system prompt defines how Kommand "thinks" — how it interprets owner messages, decides which tools to call, and formats responses.

---

## System Prompt (for Claude API call)

```
You are Kommand, an AI business operations assistant. You help small business owners manage their e-commerce stores and finances through natural conversation.

## Your Role
You are the owner's trusted COO — concise, proactive, and action-oriented. You have access to their business tools (Shopify, Xero, Stripe, etc.) through function calls. Use them to answer questions and execute commands.

## Communication Style
- Be concise. Business owners are busy. Lead with the answer, then details.
- Use numbers and specifics. "Revenue is $4,820 today (↑12% vs last Tuesday)" not "Revenue looks good."
- Format for mobile chat. Short paragraphs. Use line breaks. Emoji sparingly for visual anchors (📦 ✅ ⚡ 📊).
- Never say "I don't have access to that" if a tool exists. Try the tool first.
- If a tool call fails, explain what happened simply and suggest alternatives.
- For currency, use the store's configured currency (available in context).

## Decision Rules

### When the owner asks a QUESTION:
1. Determine which tool(s) can answer it
2. Call the tools (you can call multiple in parallel)
3. Synthesize the results into a clear, concise answer
4. Include relevant context the owner didn't ask for but would want to know

### When the owner gives a COMMAND:
1. Determine the action and required parameters
2. Check the confirmation tier:
   - Tier 0 (read-only): Execute immediately
   - Tier 1 (low-risk write): Confirm briefly → "Send invoice #289 to Fatima for $7,800?"
   - Tier 2 (medium-risk): Confirm with details → show what will happen
   - Tier 3 (high-risk): Double confirm → "This will change prices on 47 products. Type CONFIRM to proceed."
3. If parameters are missing, ask for them naturally (don't list requirements robotically)
4. Execute and report the result

### When the owner says something AMBIGUOUS:
- Make your best interpretation and ask a clarifying question only if truly needed
- "Refund Ahmed" → look up Ahmed's most recent order, propose the refund
- "How's things?" → give a business summary (sales today, orders, any alerts)

### Confirmation Tier Assignment:
- Tier 0: All read operations (get_orders, get_inventory, get_invoices, etc.)
- Tier 1: send_invoice, send_reminder, create_discount, fulfill_order
- Tier 2: refund_order, cancel_order, update_price (single product)
- Tier 3: bulk_update_prices, delete_product, any operation affecting >5 items

## Context You Receive
Each message includes:
- owner_name: The business owner's first name
- store_name: Their store name
- currency: Their store currency (e.g., "AED", "USD")
- timezone: Their timezone
- connected_tools: List of what's connected (shopify, xero, stripe, etc.)
- recent_messages: Last 10 messages in this conversation for continuity

## What You Never Do
- Never make up data. If a tool call returns an error, say so.
- Never expose raw API errors. Translate to human language.
- Never mention "tool calls" or "function calls" — the owner shouldn't know about the machinery.
- Never suggest the owner check a dashboard. YOU are the dashboard.
- Never give generic business advice. Use THEIR actual data.
```

---

## Tool Definitions Pattern

Every tool registered with the AI brain follows this interface:

```typescript
interface ToolDefinition {
  name: string;                    // e.g., "get_orders_summary"
  description: string;             // What the tool does (AI reads this to decide when to use it)
  input_schema: JSONSchema;        // Zod schema → JSON Schema for parameters
  confirmation_tier: 0 | 1 | 2 | 3;
  platform: 'shopify' | 'xero' | 'stripe' | 'internal';
  handler: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  userId: string;
  storeId?: string;
  connectionId?: string;
  currency: string;
  timezone: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;                  // Structured data for the AI to interpret
  display?: string;                // Pre-formatted string if we want to control the output
  error?: string;
}
```

---

## Tool Registry (V1)

### Shopify Tools

| Tool Name | Description (for AI) | Tier | Parameters |
|-----------|---------------------|------|------------|
| `get_sales_summary` | Get sales summary for a time period. Returns revenue, order count, AOV. | 0 | `{ period: "today" \| "yesterday" \| "this_week" \| "this_month" \| "last_7_days" \| "last_30_days" }` |
| `compare_periods` | Compare sales between two time periods. | 0 | `{ period_a: string, period_b: string }` |
| `get_recent_orders` | Get the most recent orders. | 0 | `{ limit?: number, status?: "any" \| "unfulfilled" \| "fulfilled" }` |
| `get_order_details` | Get full details of a specific order by order number or name. | 0 | `{ order_identifier: string }` |
| `get_best_sellers` | Get top-selling products for a time period. | 0 | `{ period: string, limit?: number }` |
| `get_product_inventory` | Check inventory levels for a product or all products. | 0 | `{ product_name?: string }` |
| `get_customer_summary` | Get customer stats: total, new, returning, top by LTV. | 0 | `{ period?: string }` |
| `search_customers` | Search for a customer by name, email, or phone. | 0 | `{ query: string }` |
| `list_active_discounts` | List all currently active discount codes. | 0 | `{}` |
| `refund_order` | Issue a full or partial refund for an order. | 2 | `{ order_identifier: string, amount?: number, reason?: string }` |
| `cancel_order` | Cancel an unfulfilled order. | 2 | `{ order_identifier: string, reason?: string, restock?: boolean }` |
| `fulfill_order` | Mark an order as fulfilled with optional tracking. | 1 | `{ order_identifier: string, tracking_number?: string, tracking_company?: string }` |
| `update_product_price` | Change the price of a product variant. | 2 | `{ product_name: string, new_price: number, variant?: string }` |
| `create_discount` | Create a new discount code. | 1 | `{ code: string, type: "percentage" \| "fixed", value: number, starts_at?: string, ends_at?: string }` |
| `disable_discount` | Deactivate a discount code. | 1 | `{ code: string }` |

### Xero Tools

| Tool Name | Description (for AI) | Tier | Parameters |
|-----------|---------------------|------|------------|
| `get_invoices` | List invoices filtered by status. | 0 | `{ status?: "draft" \| "submitted" \| "authorised" \| "paid" \| "overdue" }` |
| `get_invoice_details` | Get details of a specific invoice. | 0 | `{ invoice_number: string }` |
| `create_invoice` | Create a new invoice for a contact. | 1 | `{ contact_name: string, line_items: Array<{description: string, quantity: number, unit_amount: number}>, due_date?: string }` |
| `send_invoice` | Send an invoice to the contact via email. | 1 | `{ invoice_number: string }` |
| `get_overdue_invoices` | Get all overdue invoices with amounts and days overdue. | 0 | `{}` |
| `send_invoice_reminder` | Send a payment reminder for an overdue invoice. | 1 | `{ invoice_number: string }` |
| `get_bills_due` | Get upcoming bills due in the next N days. | 0 | `{ days?: number }` |
| `get_profit_loss` | Get profit and loss summary for a period. | 0 | `{ period: "this_month" \| "last_month" \| "this_quarter" \| "this_year" }` |
| `get_accounts_receivable` | Get total accounts receivable summary. | 0 | `{}` |
| `get_cash_summary` | Get cash position across all bank accounts. | 0 | `{}` |

---

## Context Injection

Before every Claude API call, we inject business context:

```typescript
function buildUserContext(user: User, stores: Store[], connections: Connection[]): string {
  return `
## Business Context
- Owner: ${user.name}
- Store(s): ${stores.map(s => `${s.shop_name} (${s.platform})`).join(', ')}
- Currency: ${stores[0]?.currency || 'USD'}
- Timezone: ${user.timezone}
- Connected tools: ${[
    ...stores.map(s => s.platform),
    ...connections.map(c => c.platform)
  ].join(', ')}
- Current time: ${new Date().toLocaleString('en-US', { timeZone: user.timezone })}
- Plan: ${user.plan}
`;
}
```

---

## Conversation Memory

- Store last 20 messages per conversation in the DB
- Inject last 10 messages into each Claude API call as prior conversation
- Token budget: ~2000 tokens for history, ~1500 for context, rest for tools + response
- If conversation is long, summarize older messages into a "conversation summary" injected at the start

---

## Response Formatting Rules

The AI returns plain text which gets formatted per channel:

| Pattern | WhatsApp Rendering |
|---------|-------------------|
| `**bold**` | *bold* (WhatsApp bold) |
| `$1,234.56` | Unchanged |
| `↑12%` / `↓5%` | Unchanged (emoji arrows) |
| Bullet lists | Use line breaks + emoji bullets |
| Tables | Convert to aligned text blocks |
| Charts/graphs | Generate image via QuickChart API, send as WhatsApp image |

---

## Rate Limiting

- Max 30 Claude API calls per user per hour (prevents abuse)
- Max 5 write operations per user per minute (prevents accidental mass-actions)
- Max 100 messages per user per day on Starter plan
- Cooldown: after 3 failed tool calls in a row, suggest checking the dashboard
