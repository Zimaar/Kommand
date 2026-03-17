# ONE-SHOTTABLE PROMPTS — Complete Guide

> **How to use this file:**
> 1. Open your AI coding tool (Claude Code, Cursor, Codex)
> 2. Load `PROJECT_BIBLE.md` as system/project context
> 3. Copy-paste each prompt in order within its milestone
> 4. Run the validation step after each prompt
> 5. Commit after each successful prompt
>
> **Rules:**
> - CONTEXT lines mean "also include this file's content in the prompt"
> - Each prompt is self-contained within its milestone — don't skip ahead
> - If a prompt fails, fix the issue before moving to the next one
> - Estimated output is ~200-500 lines per prompt

---

## M0: PROJECT SETUP

### Prompt 0.1 — Monorepo Scaffold

```
Create a TypeScript monorepo using npm workspaces with the following structure:

Root:
- package.json with workspaces: ["apps/*", "packages/*"]
- tsconfig.json (base config, strict mode, ESNext target, NodeNext module resolution)
- .gitignore (node_modules, dist, .env, .turbo)
- turbo.json for Turborepo with build, dev, lint, test pipelines

Workspaces:
1. packages/shared — shared types and schemas
   - package.json (name: @kommand/shared)
   - tsconfig.json extending root
   - src/index.ts (empty barrel export)

2. apps/api — Fastify API server
   - package.json with dependencies: fastify, @fastify/cors, @fastify/sensible, dotenv, zod
   - tsconfig.json extending root
   - src/index.ts with a basic Fastify server that starts on PORT from env, has a health check route GET /health returning { status: "ok", timestamp: Date.now() }

3. apps/dashboard — Next.js 14 app
   - Use `create-next-app` config: App Router, TypeScript, Tailwind, ESLint, src/ directory, import alias @/
   - package.json
   - tsconfig.json

Include a root .env.example with all variables from the PROJECT_BIBLE.md environment variables section.

Make sure `npm run dev` from root starts both apps/api and apps/dashboard concurrently.
```

**Validate**: `npm install && npm run build` succeeds, `npm run dev` starts both servers.

---

### Prompt 0.2 — Shared Types

```
CONTEXT: specs/DATABASE_SCHEMA.md, specs/AI_BRAIN_PROMPT.md

In packages/shared/src/types/, create the following TypeScript type files:

1. messages.ts:
   - InboundMessage: { id: string, userId: string, channelType: 'whatsapp' | 'slack' | 'email' | 'telegram', channelMessageId: string, text: string, timestamp: Date, metadata?: Record<string, unknown> }
   - OutboundMessage: { userId: string, channelType: string, text: string, buttons?: Array<{id: string, title: string}>, imageUrl?: string, metadata?: Record<string, unknown> }
   - MessageDirection: 'inbound' | 'outbound'
   - MessageRole: 'user' | 'assistant' | 'system'

2. tools.ts:
   - ToolDefinition: { name: string, description: string, inputSchema: Record<string, unknown>, confirmationTier: 0 | 1 | 2 | 3, platform: ToolPlatform, handler: ToolHandler }
   - ToolPlatform: 'shopify' | 'xero' | 'quickbooks' | 'stripe' | 'internal'
   - ToolContext: { userId: string, storeId?: string, connectionId?: string, currency: string, timezone: string }
   - ToolResult: { success: boolean, data?: unknown, display?: string, error?: string }
   - ToolHandler: (params: unknown, context: ToolContext) => Promise<ToolResult>
   - ConfirmationTier enum: NONE = 0, LOW = 1, MEDIUM = 2, HIGH = 3

3. users.ts:
   - User, Store, AccountingConnection, Channel types matching the database schema
   - UserPlan: 'trial' | 'starter' | 'growth' | 'pro'

4. commands.ts:
   - Command type matching the commands table
   - CommandStatus: 'pending' | 'confirmed' | 'executed' | 'failed' | 'cancelled'
   - PendingConfirmation type matching the pending_confirmations table

5. index.ts — barrel export everything

All types should use branded types for IDs: type UserId = string & { __brand: 'UserId' }
Use readonly on all properties by default.
```

**Validate**: `cd packages/shared && npx tsc --noEmit`

---

### Prompt 0.3 — Zod Validation Schemas

```
CONTEXT: packages/shared/src/types/

In packages/shared/src/schemas/, create Zod schemas that correspond to every type in the types folder:

1. messages.schema.ts — InboundMessageSchema, OutboundMessageSchema
2. tools.schema.ts — ToolResultSchema, ToolContextSchema
3. env.schema.ts — A Zod schema that validates ALL environment variables from .env.example. Use z.string().min(1) for required vars, z.string().optional() for optional ones. Export a parseEnv() function that validates process.env and returns a typed config object.
4. index.ts — barrel export

Add zod as a dependency to packages/shared.
Use z.infer<typeof Schema> to derive types where possible, and re-export them from the types/ barrel.

The env schema should group variables logically:
- core: NODE_ENV, PORT, API_URL, DASHBOARD_URL
- database: DATABASE_URL, REDIS_URL
- ai: ANTHROPIC_API_KEY
- whatsapp: all WHATSAPP_* vars
- shopify: all SHOPIFY_* vars
- xero: all XERO_* vars
- stripe: all STRIPE_* vars
- auth: all CLERK_* vars
- monitoring: SENTRY_DSN, AXIOM_TOKEN
```

**Validate**: Write a quick test that calls `parseEnv()` with a mock env object.

---

### Prompt 0.4 — Database Schema (Drizzle ORM)

```
CONTEXT: specs/DATABASE_SCHEMA.md

In apps/api/src/db/, set up Drizzle ORM with PostgreSQL:

1. Install: drizzle-orm, drizzle-kit, postgres (driver)

2. schema.ts — Define ALL tables from DATABASE_SCHEMA.md using Drizzle's pgTable:
   - users, stores, accounting_connections, channels, conversations, messages, commands, pending_confirmations, scheduled_jobs, alert_rules
   - Use proper column types: uuid, text, boolean, timestamp, jsonb, integer
   - Define all indexes listed in the spec
   - Add relations using Drizzle's relations() helper

3. connection.ts — Database connection setup using postgres driver
   - Read DATABASE_URL from env
   - Export a `db` instance
   - Export type helpers: `type DB = typeof db`

4. migrate.ts — Migration runner script
   - Reads from drizzle/migrations folder

5. drizzle.config.ts — Drizzle Kit config for migration generation

6. Add npm scripts to api/package.json:
   - "db:generate": "drizzle-kit generate"
   - "db:migrate": "tsx src/db/migrate.ts"
   - "db:studio": "drizzle-kit studio"
```

**Validate**: `npm run db:generate` produces migration files.

---

### Prompt 0.5 — Docker Compose + Seed

```
Create at the project root:

1. docker-compose.yml with:
   - postgres:16 service on port 5432, with volume for persistence, POSTGRES_DB=kommand
   - redis:7 service on port 6379
   - Both with health checks

2. scripts/seed.ts — A TypeScript seed script that:
   - Connects to the local database
   - Creates a test user: { email: "test@kommand.dev", name: "Test Owner", phone: "+971501234567", timezone: "Asia/Dubai", plan: "growth" }
   - Creates a test Shopify store connection: { platform: "shopify", shop_domain: "test-store.myshopify.com", shop_name: "Test Store" } — use a dummy encrypted token
   - Creates a test WhatsApp channel: { type: "whatsapp", channel_id: "test-phone-id" }
   - Creates a morning_brief scheduled job for the test user
   - Logs all created records

3. Add to root package.json:
   - "docker:up": "docker compose up -d"
   - "docker:down": "docker compose down"
   - "db:seed": "tsx scripts/seed.ts"
```

**Validate**: `npm run docker:up && npm run db:migrate && npm run db:seed` — all succeed, records visible in DB.

---

### Prompt 0.6 — CI Pipeline

```
Create .github/workflows/ci.yml:

Trigger: push to main, pull requests to main

Jobs:
1. lint-and-type-check:
   - Setup Node 20
   - npm ci
   - npm run lint (add eslint to root if not present)
   - npx tsc --noEmit (all workspaces)

2. test:
   - Setup Node 20
   - Start Postgres and Redis via services
   - npm ci
   - npm run db:migrate
   - npm run test (will be empty for now, but the infrastructure should work)

3. build:
   - npm run build (all workspaces)

Use caching for node_modules. Use matrix strategy if needed.
Also create a simple .eslintrc.js at root with TypeScript plugin, no-unused-vars as warn, and consistent-type-imports rule.
```

**Validate**: Push to GitHub, Actions run green.

---

## M1: CORE ENGINE

### Prompt 1.1 — Fastify Server Bootstrap

```
CONTEXT: packages/shared/src/schemas/env.schema.ts

In apps/api/src/, expand the Fastify server:

1. index.ts — Full bootstrap:
   - Parse and validate env using parseEnv()
   - Register plugins: @fastify/cors, @fastify/sensible
   - Register custom error handler that catches AppError and returns structured JSON
   - Register routes from a routes/ folder
   - Graceful shutdown handler (close DB, Redis)
   - Start server

2. config/index.ts:
   - Export validated env as a typed singleton
   - Export app constants: MAX_MESSAGE_LENGTH = 4000, CONVERSATION_HISTORY_LIMIT = 10, CONFIRMATION_TIMEOUT_MS = 600000 (10 min)

3. utils/errors.ts:
   - AppError class extending Error with: statusCode, code (string enum), isOperational flag
   - Error codes: UNAUTHORIZED, NOT_FOUND, VALIDATION_ERROR, TOOL_EXECUTION_ERROR, RATE_LIMIT_EXCEEDED, EXTERNAL_API_ERROR

4. middleware/request-logger.ts:
   - Fastify hook that logs: method, url, statusCode, duration, userId (if present)
   - Structured JSON format for Axiom

5. GET /health — returns { status: "ok", version: string, uptime: number }
```

**Validate**: `npm run dev` starts API, `curl localhost:3000/health` returns JSON.

---

### Prompt 1.2 — Message Ingestion Pipeline

```
CONTEXT: packages/shared/src/types/messages.ts, apps/api/src/config/index.ts

Create apps/api/src/channels/ingestion.ts and the webhook route:

1. routes/webhook.ts:
   - POST /webhook/:channelType — receives raw messages from any channel
   - Validates channelType is a known type
   - Passes raw body to the channel-specific adapter (placeholder for now)
   - Returns 200 immediately (async processing)

2. channels/ingestion.ts — MessageIngestionService:
   - processInbound(channelType: string, rawBody: unknown): Promise<void>
   - Steps:
     a. Normalize raw body → InboundMessage (via channel adapter)
     b. Deduplicate by channelMessageId (check Redis SET with 1hr TTL)
     c. Validate message length (truncate to MAX_MESSAGE_LENGTH)
     d. Look up user by channel info (phone number for WhatsApp)
     e. Store message in DB
     f. Check for pending confirmations (if user replied "yes"/"no", handle that)
     g. Otherwise, pass to AI Brain for processing
     h. Send response back via outbound channel adapter

3. channels/adapter.interface.ts:
   - ChannelAdapter interface: { parseInbound(raw: unknown): InboundMessage, formatOutbound(msg: OutboundMessage): unknown, send(formatted: unknown): Promise<void> }

4. channels/adapters/mock.adapter.ts:
   - A mock adapter for testing that logs messages to console

Make the pipeline async — the webhook returns 200 and processing happens in background.
Use a simple in-memory queue for now (replace with BullMQ in M6).
```

**Validate**: `curl -X POST localhost:3000/webhook/whatsapp -H 'Content-Type: application/json' -d '{"test": true}'` returns 200, log shows processing.

---

### Prompt 1.3 — AI Brain (Claude API Integration)

```
CONTEXT: specs/AI_BRAIN_PROMPT.md, packages/shared/src/types/tools.ts

Create apps/api/src/core/ai-brain.ts — The central AI engine:

1. Install @anthropic-ai/sdk

2. AiBrain class:
   - constructor receives: anthropic client, tool registry, config
   - processMessage(message: InboundMessage, context: UserContext): Promise<AiBrainResponse>
     a. Build the messages array: system prompt + conversation history + new user message
     b. Build the tools array from the tool registry (convert ToolDefinitions to Claude tool format)
     c. Call claude-sonnet-4-20250514 with messages + tools
     d. If response contains tool_use blocks:
        - For each tool_use, call the tool dispatcher
        - Collect results
        - Send results back to Claude as tool_result messages
        - Get the final text response
     e. Return: { text: string, toolCalls: ToolCall[], tokensUsed: number }

3. core/system-prompt.ts:
   - Export the full system prompt as a template literal
   - buildSystemPrompt(context: UserContext): string — injects business context

4. core/tool-registry.ts:
   - ToolRegistry class:
     - register(tool: ToolDefinition): void
     - getAll(): ToolDefinition[]
     - getForClaude(): ClaudeToolFormat[] — converts to Claude's expected schema
     - get(name: string): ToolDefinition | undefined

5. types for this module:
   - UserContext: { userId, name, storeName, currency, timezone, connectedTools, conversationHistory }
   - AiBrainResponse: { text: string, toolCalls: Array<{name: string, input: unknown, result: ToolResult}>, tokensUsed: number, latencyMs: number }

Handle the multi-turn tool-use loop: Claude may call multiple tools, and you need to send ALL results back before getting the final response. Max 5 tool-use iterations to prevent infinite loops.
```

**Validate**: Write a unit test with a mock Claude client that returns a simple text response.

---

### Prompt 1.4 — Tool Dispatcher

```
CONTEXT: apps/api/src/core/tool-registry.ts, packages/shared/src/types/tools.ts

Create apps/api/src/core/tool-dispatcher.ts:

1. ToolDispatcher class:
   - constructor(registry: ToolRegistry, confirmationEngine: ConfirmationEngine)
   
   - dispatch(toolName: string, params: unknown, context: ToolContext): Promise<ToolResult>
     a. Look up tool in registry
     b. Validate params against tool's inputSchema (Zod)
     c. Check confirmation tier:
        - Tier 0: execute immediately
        - Tier 1-3: create PendingConfirmation, return result with { success: true, data: { requiresConfirmation: true, confirmationId, promptText } }
     d. Execute tool handler
     e. Log to commands table
     f. Return ToolResult

   - executeConfirmed(confirmationId: string, context: ToolContext): Promise<ToolResult>
     a. Load pending confirmation
     b. Execute the original tool handler with stored params
     c. Update command status to 'executed'
     d. Delete pending confirmation
     e. Return ToolResult

2. Error wrapping:
   - If tool handler throws, catch and return ToolResult with success: false and friendly error message
   - Log the raw error to Sentry
   - Never expose raw API errors to the AI

3. Idempotency:
   - Generate idempotency key from: userId + toolName + JSON.stringify(params) + date (to hour)
   - Check commands table before executing
   - If duplicate found, return the previous result
```

**Validate**: Unit test with a mock tool that returns static data. Test idempotency by calling twice.

---

### Prompt 1.5 — Confirmation Engine

```
CONTEXT: apps/api/src/core/tool-dispatcher.ts, packages/shared/src/types/commands.ts

Create apps/api/src/core/confirmation-engine.ts:

1. ConfirmationEngine class:
   - constructor(db: DB)

   - createConfirmation(params: { userId, commandId, channelId, toolName, toolParams, tier, promptText }): Promise<PendingConfirmation>
     - Store in pending_confirmations table
     - Set expires_at to now + CONFIRMATION_TIMEOUT_MS
     - Return the confirmation with ID

   - handleResponse(userId: string, responseText: string): Promise<{ handled: boolean, result?: ToolResult }>
     - Check if user has any pending confirmations
     - Parse response: "yes", "y", "confirm", "1" → confirmed; "no", "n", "cancel", "0" → cancelled
     - If confirmed → execute via tool dispatcher
     - If cancelled → update status, return friendly "Cancelled" message
     - If no pending confirmation exists → return { handled: false }
     - For Tier 3: check if response is exactly "CONFIRM" (case-insensitive)

   - cleanupExpired(): Promise<number>
     - Run periodically (every minute)
     - Find all pending confirmations past expires_at
     - Update status to 'expired'
     - Return count of expired

   - getPromptText(toolName: string, params: unknown, tier: number, context: ToolContext): string
     - Generate human-friendly confirmation prompt based on the action
     - Tier 1: "Send invoice #289 to Fatima for $7,800? (Yes/No)"
     - Tier 2: "Refund $145.00 to Ahmed for order #1847?\n  Reason: Customer request\n  Method: Original payment\n  (Yes/No)"
     - Tier 3: "⚠️ Update prices on 47 products by +20%?\n  This affects your entire catalog.\n  Type CONFIRM to proceed or No to cancel."
```

**Validate**: Unit test: create confirmation → respond "yes" → tool executes. Create confirmation → wait → expires.

---

### Prompt 1.6 — Response Formatter

```
CONTEXT: packages/shared/src/types/messages.ts

Create apps/api/src/core/response-formatter.ts:

1. ResponseFormatter class:
   - formatForChannel(text: string, channelType: string, extras?: { buttons?: Array<{id, title}>, imageUrl?: string }): OutboundMessage
   
   - formatWhatsApp(text: string): string
     - Convert **bold** to *bold* (WhatsApp uses single asterisks)
     - Convert `code` to ```code```
     - Ensure line breaks are preserved
     - Truncate to 4096 chars (WhatsApp limit) with "..." if needed
   
   - formatSlack(text: string): string
     - Convert to Slack markdown (mrkdwn)
     - Bold stays **bold**
   
   - formatPlainText(text: string): string
     - Strip all markdown formatting
     - Used for email/SMS fallback

2. Smart formatting helpers:
   - formatCurrency(amount: number, currency: string): string
     - Uses Intl.NumberFormat
     - "AED 1,234.56" or "$1,234.56"
   
   - formatPercentChange(current: number, previous: number): string
     - "↑12%" or "↓5%" or "→ flat"
   
   - formatRelativeTime(date: Date): string
     - "2 hours ago", "yesterday", "3 days ago"

   - formatOrderSummary(orders: any[]): string
     - Concise multi-line format for chat display

3. Chart image generation (for future use):
   - generateChartUrl(config: ChartConfig): string
   - Uses QuickChart.io API to generate chart images from data
   - Returns a URL that can be sent as a WhatsApp image
```

**Validate**: Unit tests for each formatter. WhatsApp: input `"**Sales** today: $1,234"` → output `"*Sales* today: $1,234"`.

---

### Prompt 1.7 — Conversation Memory

```
CONTEXT: apps/api/src/db/schema.ts (messages + conversations tables)

Create apps/api/src/core/conversation-manager.ts:

1. ConversationManager class:
   - constructor(db: DB)

   - getOrCreateConversation(userId: string, channelId: string): Promise<string>
     - Check for existing conversation from this channel in last 24 hours
     - If exists, return its ID
     - If not, create new one, return ID

   - addMessage(conversationId: string, message: { direction, role, content, channelMessageId?, toolCalls?, toolResults?, tokensUsed?, latencyMs? }): Promise<string>
     - Insert into messages table
     - Update conversation.last_message_at
     - Return message ID

   - getHistory(conversationId: string, limit?: number): Promise<Array<{ role, content }>>
     - Get last N messages (default: CONVERSATION_HISTORY_LIMIT from config)
     - Return in chronological order (oldest first)
     - Format for Claude API: { role: 'user' | 'assistant', content: string }

   - getHistoryForContext(userId: string, channelId: string): Promise<Array<{ role, content }>>
     - Convenience method: gets conversation → gets history
     - Used by AI Brain before each Claude call

   - summarizeIfLong(conversationId: string): Promise<string | null>
     - If conversation has > 30 messages, generate a summary of the first 20
     - Use a lightweight Claude call to summarize
     - Store summary as a 'system' message at the top
     - Return the summary
```

**Validate**: Unit test: add 5 messages → getHistory returns them in order. Add 35 messages → summarize triggers.

---

### Prompt 1.8 — Error Handling & Fallbacks

```
CONTEXT: apps/api/src/utils/errors.ts, apps/api/src/core/ai-brain.ts

Create apps/api/src/core/error-handler.ts and update the AI brain:

1. error-handler.ts — Global error handling for the message pipeline:
   
   - handlePipelineError(error: unknown, userId: string, channelType: string): OutboundMessage
     - If AppError with RATE_LIMIT_EXCEEDED: "You've sent a lot of messages. Give me a moment and try again in a few minutes."
     - If AppError with EXTERNAL_API_ERROR: "I'm having trouble connecting to {platform}. This is usually temporary — try again in a minute."
     - If AppError with TOOL_EXECUTION_ERROR: "I tried to {action} but something went wrong. Here's what I know: {friendly error}. Want me to try again?"
     - If unknown error: "Something unexpected happened on my end. I've logged the issue. Can you try that again?"
     - Always log the full error with stack trace to Sentry/console

2. Retry logic (in tool dispatcher):
   - If a tool call fails with a transient error (timeout, 5xx), retry once with exponential backoff
   - If retry also fails, return the error to the AI brain with context
   - Max retry budget: 2 retries per tool call, 5 total retries per message

3. Circuit breaker (per platform):
   - Track failures per platform (Shopify, Xero, etc.) in Redis
   - If >5 failures in 5 minutes, open circuit for that platform
   - When open: immediately return "Shopify seems to be having issues right now. I'll keep trying in the background."
   - Half-open after 2 minutes: try one request
   - If succeeds, close circuit

4. Graceful degradation:
   - If Claude API is down: "I'm having a brain freeze. For urgent tasks, check your Shopify admin directly. I'll be back shortly."
   - If Redis is down: skip dedup + rate limiting, log warning, continue processing
   - If DB is down: "I can't access my memory right now. Please try again in a moment."

Update the message ingestion pipeline to use handlePipelineError as the catch-all.
```

**Validate**: Unit test: mock a tool throwing an error → handlePipelineError returns a friendly message.

---

## M2: SHOPIFY INTEGRATION

### Prompt 2.1 — Shopify OAuth + Token Management

```
CONTEXT: specs/SECURITY.md (encryption section), apps/api/src/db/schema.ts (stores table)

Create apps/api/src/tools/shopify/auth.ts and the OAuth routes:

1. routes/shopify-auth.ts:
   - GET /auth/shopify — Initiates Shopify OAuth
     - Generates a random nonce, stores in Redis (5 min TTL)
     - Redirects to https://{shop}/admin/oauth/authorize?client_id=...&scope=...&redirect_uri=...&state={nonce}
   
   - GET /auth/shopify/callback — Handles OAuth callback
     - Validates state parameter against Redis nonce
     - Exchanges code for permanent access token via POST to Shopify
     - Encrypts the access token using AES-256-GCM
     - Stores in `stores` table with encrypted token + IV
     - Redirects to dashboard with success parameter

2. tools/shopify/client.ts — ShopifyClient:
   - constructor(shopDomain: string, encryptedToken: string, iv: string)
   - Decrypts token on instantiation
   - graphql(query: string, variables?: Record<string, unknown>): Promise<any>
     - Makes authenticated GraphQL request to Shopify Admin API
     - Handles rate limiting (retry after 1s if 429)
     - Throws AppError with EXTERNAL_API_ERROR on failure
   - rest(method: string, path: string, body?: unknown): Promise<any>
     - For REST-only endpoints
     - Same error handling

3. tools/shopify/index.ts:
   - getShopifyClient(userId: string): Promise<ShopifyClient>
     - Looks up active store for user
     - Creates and returns authenticated client
     - Throws if no store connected

4. utils/encryption.ts:
   - encrypt(plaintext: string): { ciphertext, iv, tag }
   - decrypt(ciphertext: string, iv: string, tag: string): string
   - Implementation per SECURITY.md spec
```

**Validate**: Manual test: trigger OAuth flow, verify token stored encrypted in DB.

---

### Prompt 2.2 — Shopify Order Tools (Read)

```
CONTEXT: apps/api/src/tools/shopify/client.ts, apps/api/src/core/tool-registry.ts, specs/AI_BRAIN_PROMPT.md (tool registry table)

Create apps/api/src/tools/shopify/orders-read.ts:

Register these tools with the ToolRegistry:

1. get_sales_summary:
   - Input: { period: "today" | "yesterday" | "this_week" | "this_month" | "last_7_days" | "last_30_days" }
   - GraphQL: query orders with created_at filter, aggregate
   - Returns: { revenue: number, orderCount: number, averageOrderValue: number, currency: string, period: string, comparedToPrevious?: { revenue: number, change: number } }

2. get_recent_orders:
   - Input: { limit?: number (default 5, max 20), status?: "any" | "unfulfilled" | "fulfilled" }
   - GraphQL: query last N orders with optional fulfillment status filter
   - Returns: Array<{ orderNumber: string, customerName: string, total: number, status: string, createdAt: string, itemCount: number }>

3. get_order_details:
   - Input: { order_identifier: string } — can be order number "#1234" or name
   - GraphQL: query single order by name
   - Returns: { orderNumber, customerName, customerEmail, total, subtotal, tax, shipping, status, fulfillmentStatus, paymentStatus, items: Array<{title, quantity, price}>, createdAt, shippingAddress }

4. compare_periods:
   - Input: { period_a: string, period_b: string }
   - Calls get_sales_summary for each period
   - Returns: { periodA: SalesSummary, periodB: SalesSummary, changes: { revenue: percentChange, orders: percentChange, aov: percentChange } }

5. get_best_sellers:
   - Input: { period?: string (default "last_30_days"), limit?: number (default 5) }
   - GraphQL: query order line items, aggregate by product
   - Returns: Array<{ productTitle, unitsSold, revenue, percentOfTotal }>

For each tool, define:
- Zod input schema
- Description string for the AI (concise, tells Claude WHEN to use it)
- confirmationTier: 0 (all read)
- handler function

Use Shopify Admin API 2024-10 GraphQL. All date calculations should use the user's timezone.
```

**Validate**: Unit tests with mock GraphQL responses. Test date range calculation for each period option.

---

### Prompt 2.3 — Shopify Order Tools (Write)

```
CONTEXT: apps/api/src/tools/shopify/client.ts, apps/api/src/tools/shopify/orders-read.ts

Create apps/api/src/tools/shopify/orders-write.ts:

Register these tools:

1. refund_order (Tier 2):
   - Input: { order_identifier: string, amount?: number (full refund if omitted), reason?: string }
   - First, fetch order details to validate it exists and is refundable
   - Use Shopify refund creation mutation
   - Returns: { success: true, refundAmount, orderNumber, customerName }
   - Confirmation text: "Refund {currency} {amount} to {customerName} for order {orderNumber}? (Yes/No)"

2. cancel_order (Tier 2):
   - Input: { order_identifier: string, reason?: string, restock?: boolean (default true) }
   - Validate order is cancellable (not fulfilled)
   - Use Shopify order cancel mutation
   - Returns: { success: true, orderNumber, restocked: boolean }
   - Confirmation: "Cancel order {orderNumber} ({customerName}, {total})? Items will {restock ? 'be restocked' : 'not be restocked'}. (Yes/No)"

3. fulfill_order (Tier 1):
   - Input: { order_identifier: string, tracking_number?: string, tracking_company?: string }
   - Use Shopify fulfillment creation mutation
   - Returns: { success: true, orderNumber, trackingNumber }
   - Confirmation: "Mark order {orderNumber} as fulfilled{tracking ? ' with tracking ' + tracking : ''}? (Yes/No)"

4. update_tracking:
   - Input: { order_identifier: string, tracking_number: string, tracking_company?: string }
   - Update existing fulfillment tracking
   - Tier 1

For write tools:
- Always fetch the current state first (prevent stale operations)
- Use idempotency keys
- Log everything to commands table
- Return enough context for the AI to give a good confirmation message
```

**Validate**: Unit tests with mock mutations. Test that Tier 2 tools create pending confirmations instead of executing immediately.

---

### Prompt 2.4 — Products & Inventory Tools

```
CONTEXT: apps/api/src/tools/shopify/client.ts

Create apps/api/src/tools/shopify/products.ts:

1. get_products (Tier 0):
   - Input: { search?: string, limit?: number (default 10) }
   - GraphQL: query products with optional title search
   - Returns: Array<{ title, status, price, inventory, variants, productType, createdAt }>

2. get_product_inventory (Tier 0):
   - Input: { product_name?: string }
   - If product_name provided: search for that product, return its inventory per variant per location
   - If not provided: return products with low stock (< 10 units)
   - Returns: Array<{ productTitle, variant, available, location }>

3. update_product_price (Tier 2):
   - Input: { product_name: string, new_price: number, variant?: string }
   - Search for product by name (fuzzy match)
   - If multiple matches, return them and ask which one
   - Update variant price via mutation
   - Confirmation: "Change {product} price from {old} to {new} ({currency})? (Yes/No)"

4. update_inventory (Tier 1):
   - Input: { product_name: string, adjustment: number, variant?: string, reason?: string }
   - Adjust inventory levels (positive = add, negative = remove)
   - Confirmation: "Adjust {product} inventory by {+/-}{amount} (new total: {total})? (Yes/No)"

Important: Product name matching should be fuzzy. If the owner says "white tee" and the product is "Classic White Tee - Cotton", it should match. Use a simple includes() + toLowerCase() for V1.
```

**Validate**: Unit test for fuzzy product matching. Test inventory adjustment calculation.

---

### Prompt 2.5 — Customer Tools

```
Create apps/api/src/tools/shopify/customers.ts:

1. get_customer_summary (Tier 0):
   - Input: { period?: string (default "this_month") }
   - Returns: { totalCustomers, newCustomers, returningCustomers, averageOrderValue, topCustomers: Array<{name, email, totalSpent, orderCount}> }

2. search_customers (Tier 0):
   - Input: { query: string }
   - Search by name, email, or phone
   - Returns: Array<{ name, email, phone, totalSpent, orderCount, lastOrderDate, tags }>

3. get_top_customers (Tier 0):
   - Input: { limit?: number (default 10), sortBy?: "total_spent" | "order_count" }
   - Returns sorted customer list with LTV data
```

---

### Prompt 2.6 — Discount Tools

```
Create apps/api/src/tools/shopify/discounts.ts:

1. list_active_discounts (Tier 0):
   - Returns: Array<{ code, type, value, usageCount, startsAt, endsAt, status }>

2. create_discount (Tier 1):
   - Input: { code: string, type: "percentage" | "fixed_amount", value: number, starts_at?: string, ends_at?: string, usage_limit?: number }
   - Confirmation: "Create discount {CODE} for {value}% off, active {date range}? (Yes/No)"

3. disable_discount (Tier 1):
   - Input: { code: string }
   - Deactivates the discount code
   - Confirmation: "Disable discount code {CODE}? (Yes/No)"
```

---

### Prompt 2.7 — Analytics Tools

```
Create apps/api/src/tools/shopify/analytics.ts:

This is the "smart" layer — tools that combine multiple data points:

1. get_business_summary (Tier 0):
   - Input: { period?: string (default "today") }
   - Calls multiple Shopify queries in parallel:
     - Orders summary
     - Top selling products
     - New vs returning customers
     - Unfulfilled orders count
   - Returns a synthesized summary object that the AI can format nicely
   - This is what powers "How's today going?"

2. get_trends (Tier 0):
   - Input: { metric: "revenue" | "orders" | "aov", days?: number (default 7) }
   - Fetches daily data points for the metric
   - Calculates: trend direction, best day, worst day, day-over-day changes
   - Returns: { dataPoints: Array<{date, value}>, trend: "up" | "down" | "flat", average, peak, trough }

Register ALL tools from prompts 2.2-2.7 in a single shopify-tools.ts barrel file that calls registry.register() for each.
```

**Validate**: Integration test using Shopify mock data. Test get_business_summary returns a coherent summary.

---

## M3: WHATSAPP CHANNEL

### Prompt 3.1 — Webhook Verification

```
Create apps/api/src/channels/adapters/whatsapp/webhook.ts:

1. GET /webhook/whatsapp — Verification endpoint for Meta
   - Meta sends: hub.mode, hub.verify_token, hub.challenge
   - If hub.mode === "subscribe" and hub.verify_token matches WHATSAPP_VERIFY_TOKEN
   - Return hub.challenge as plain text (not JSON!)
   - Otherwise return 403

This is the first endpoint Meta hits when you register the webhook URL.
It must return the challenge as a plain text response, not wrapped in JSON.
```

**Validate**: `curl "localhost:3000/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=kommand-verify-2024&hub.challenge=test123"` returns `test123`.

---

### Prompt 3.2 — Inbound Message Handler

```
CONTEXT: specs/SECURITY.md (webhook signature verification)

Create apps/api/src/channels/adapters/whatsapp/inbound.ts:

1. POST /webhook/whatsapp — Receives messages from Meta Cloud API
   - Verify X-Hub-Signature-256 header (CRITICAL for security)
   - Parse the complex nested webhook payload from Meta:
     - entry[].changes[].value.messages[] — actual messages
     - entry[].changes[].value.statuses[] — delivery status updates (read receipts)
   - For each message:
     - Extract: from (phone number), text.body (message text), timestamp, message ID, message type
     - Handle message types: text, interactive (button replies, list replies), image (future), location (future)
     - For button replies: extract button.payload as the text
     - For list replies: extract list_reply.id as the text
   - Pass to MessageIngestionService.processInbound()
   - Return 200 immediately (Meta retries on non-200)

2. Handle status updates:
   - delivered, read, failed statuses
   - Update message status in DB (for delivery tracking in dashboard)
   - Don't process these as messages

Important: Meta sends a LOT of webhook events. Filter to only process actual text messages and interactive replies. Ignore typing indicators, reaction events, etc.
```

**Validate**: Send a mock Meta webhook payload → message processes through the pipeline.

---

### Prompt 3.3 — Outbound Message Sender

```
Create apps/api/src/channels/adapters/whatsapp/outbound.ts:

1. WhatsAppSender class:
   - constructor(phoneNumberId: string, accessToken: string)
   
   - sendText(to: string, text: string): Promise<WhatsAppSendResult>
     - POST to https://graph.facebook.com/v18.0/{phoneNumberId}/messages
     - Body: { messaging_product: "whatsapp", to, type: "text", text: { body: text } }
     - Returns: { messageId, status }
   
   - sendButtons(to: string, text: string, buttons: Array<{id, title}>): Promise<WhatsAppSendResult>
     - Max 3 buttons per message (WhatsApp limit)
     - Body: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text }, action: { buttons: [...] } } }
   
   - sendList(to: string, text: string, sections: Array<{title, rows: Array<{id, title, description?}>}>): Promise<WhatsAppSendResult>
     - For longer option lists (max 10 items)
   
   - sendImage(to: string, imageUrl: string, caption?: string): Promise<WhatsAppSendResult>
     - For chart images and visual reports
   
   - markAsRead(messageId: string): Promise<void>
     - Marks the inbound message as read (blue checkmarks)

2. Rate limiting:
   - WhatsApp has a 250 messages/second limit
   - Use a token bucket in Redis
   - Queue messages if rate exceeded

3. Error handling:
   - Parse WhatsApp error responses (they have specific error codes)
   - Handle common errors: invalid phone number, template not approved, rate limited
   - Throw AppError with meaningful messages
```

**Validate**: Mock the Facebook Graph API. Test sendText produces correct request body. Test button limit enforcement.

---

### Prompt 3.4 — WhatsApp Channel Adapter

```
CONTEXT: apps/api/src/channels/adapter.interface.ts

Create apps/api/src/channels/adapters/whatsapp/adapter.ts:

1. WhatsAppAdapter implements ChannelAdapter:
   
   - parseInbound(raw: WhatsAppWebhookPayload): InboundMessage
     - Extracts: phone number → userId lookup, message text, message ID, timestamp
     - Maps phone number to user via channels table
     - If no user found for this phone number, logs and ignores
   
   - formatOutbound(msg: OutboundMessage): WhatsAppFormattedMessage
     - Applies WhatsApp text formatting (bold, lists, etc.)
     - If msg.buttons present and ≤3, format as button message
     - If msg.buttons present and >3, format as list message
     - If msg.imageUrl present, format as image message with caption
     - Truncate text to 4096 chars
   
   - send(formatted: WhatsAppFormattedMessage): Promise<void>
     - Uses WhatsAppSender to dispatch
     - Stores outbound message in DB

2. Phone number normalization:
   - Always store in E.164 format (+971501234567)
   - Handle common formats: "0501234567", "+971 50 123 4567", "00971501234567"
   - Export normalizePhoneNumber(input: string, defaultCountryCode?: string): string

3. Register the adapter in the channel adapter factory:
   - channels/factory.ts — getAdapter(channelType: string): ChannelAdapter
```

**Validate**: Unit test: parse a real Meta webhook JSON → correct InboundMessage. Test phone number normalization with various formats.

---

### Prompt 3.5 — Message Templates + Rich Formatting

```
Create apps/api/src/channels/adapters/whatsapp/templates.ts:

1. Template message support:
   - WhatsApp requires pre-approved templates for business-initiated messages (messages sent outside the 24-hour window)
   - Define template structures for:
     - morning_brief: "Good morning {name}! Here's your business update: {body}"
     - alert: "⚡ Alert for {store_name}: {body}"
     - confirmation: "Please confirm: {body}"
   
   - sendTemplate(to: string, templateName: string, params: Record<string, string>): Promise<void>

2. Rich formatting helpers:
   - formatMorningBrief(data: BusinessSummary): string
     - Creates the morning brief message with emoji sections, numbers, and clear structure
     - Example output matching the "Morning brief" format from PROJECT_BIBLE
   
   - formatOrderNotification(order: OrderData): string
     - "📦 New order #{number} from {customer} — {currency} {total}"
   
   - formatInventoryAlert(product: ProductData): string
     - "⚠️ Low stock: {product} has {count} units left (avg {daily_rate}/day = ~{days_left} days supply)"
   
   - formatComparison(periodA: Summary, periodB: Summary): string
     - Side-by-side comparison with up/down arrows

3. Chart generation (via QuickChart API):
   - generateSalesChart(dataPoints: Array<{date, value}>, title: string): string
     - Returns a QuickChart URL for a line/bar chart
     - Chart is mobile-optimized (small, high contrast, large labels)
     - Can be sent as WhatsApp image
```

**Validate**: Test formatMorningBrief with sample data. Verify QuickChart URL generates a valid image.

---

## M4: WEB DASHBOARD

### Prompt 4.1 — Next.js Scaffold + Auth

```
In apps/dashboard/, set up the Next.js app with Clerk authentication:

1. Install: @clerk/nextjs, @clerk/themes

2. src/middleware.ts — Clerk middleware protecting all routes except /, /sign-in, /sign-up, /api/webhooks

3. src/app/layout.tsx — Root layout with ClerkProvider, fonts, Tailwind globals

4. src/app/(auth)/sign-in/page.tsx — Clerk SignIn component
5. src/app/(auth)/sign-up/page.tsx — Clerk SignUp component

6. src/app/(dashboard)/layout.tsx — Dashboard layout with:
   - Sidebar navigation: Overview, Connections, Settings, Conversation Log
   - Top bar with user avatar (Clerk UserButton), store name
   - Main content area

7. src/app/(dashboard)/page.tsx — Overview page (placeholder: "Welcome to Kommand. Connect your store to get started.")

8. src/lib/api.ts — API client helper:
   - Uses fetch with Clerk token for auth
   - Base URL from env
   - get<T>(path), post<T>(path, body), put<T>(path, body), delete(path)

Use Tailwind + shadcn/ui components. Install: button, card, input, label, badge, separator, dropdown-menu, dialog, toast, tabs.
Color scheme: clean white/gray, primary accent: deep purple (#534AB7). Dark mode support via next-themes.
```

**Validate**: `npm run dev` in dashboard → shows Clerk sign-in page → after sign-in, shows dashboard layout.

---

### Prompt 4.2 — Landing / Marketing Page

```
CONTEXT: /mnt/skills/public/frontend-design/SKILL.md

Create apps/dashboard/src/app/page.tsx — A single-page marketing site:

Aesthetic: Premium SaaS. Think Linear meets Stripe. Dark hero section, clean white features section.

Sections:
1. Hero: "Your business, as a conversation." + subtitle + CTA "Start free trial" + mock WhatsApp chat screenshot
2. Problem: "You check 8 apps a day just to run your store" — show the app icons in a chaotic grid, then Kommand as the single calm center
3. How it works: 3 steps — Connect → Chat → Control (with example messages)
4. Features grid: 6 cards (Sales queries, Order management, Invoice control, Proactive alerts, Smart reports, Multi-platform)
5. Pricing: 3 plan cards from ROADMAP.md pricing table
6. CTA: "Ready to run your business from WhatsApp?" + sign up button
7. Footer: Links, "Built for founders by founders", product hunt badge placeholder

The mock WhatsApp chat in the hero should show a realistic 3-message exchange:
- Owner: "How's today?"
- Kommand: Sales summary with numbers
- Owner: "Refund order #1847"
- Kommand: Confirmation with details

Make it responsive. Mobile-first.
```

**Validate**: Visual inspection on desktop and mobile viewport.

---

### Prompt 4.3 — Onboarding: Connect Shopify

```
Create apps/dashboard/src/app/(dashboard)/onboarding/page.tsx:

A multi-step onboarding wizard. Step 1 of 3: Connect your Shopify store.

UI:
- Progress bar showing step 1/3
- Illustration/icon of Shopify logo
- Input field for store URL (mystore.myshopify.com)
- "Connect Shopify" button → redirects to OAuth flow
- If already connected: show green checkmark + store name + "Connected" badge
- "Skip" link to proceed without connecting

Logic:
- On button click: POST to /api/connections/shopify/initiate with the store URL
- API returns the Shopify OAuth redirect URL
- Redirect the user to Shopify for authorization
- After OAuth callback, redirect back to /onboarding?step=2&shopify=connected

API route (in apps/api):
- POST /api/connections/shopify/initiate — validates store URL, generates OAuth URL
- GET /api/connections/shopify/callback — handles OAuth callback (already built in M2)
- GET /api/connections — returns all connections for the current user
```

**Validate**: Full OAuth flow test with a Shopify development store.

---

### Prompt 4.4 — Onboarding: Connect WhatsApp

```
Create the WhatsApp connection step (step 2 of onboarding):

apps/dashboard/src/app/(dashboard)/onboarding/whatsapp/page.tsx:

UI:
- Progress bar showing step 2/3
- Phone number input with country code selector (default to user's region)
- "Verify via WhatsApp" button
- After button click: show "We've sent a verification code to your WhatsApp. Enter it below:"
- 6-digit OTP input
- Once verified: show green checkmark + phone number + "Connected"
- "Skip" and "Back" links

Logic:
- POST /api/channels/whatsapp/initiate — stores the phone number, sends a WhatsApp template message with a 6-digit code
- POST /api/channels/whatsapp/verify — validates the OTP, creates the channel record
- The verification code is stored in Redis with 5-minute TTL

Note: In V1, the "verification" is simplified. The owner provides their phone number, and we send them a welcome message via WhatsApp to confirm the number works. Full WhatsApp Business embedded signup flow is a V2 enhancement.
```

**Validate**: Enter phone number → receive WhatsApp message → enter code → channel created in DB.

---

### Prompt 4.5 — Onboarding: Preferences

```
Create step 3 of onboarding:

apps/dashboard/src/app/(dashboard)/onboarding/preferences/page.tsx:

UI:
- Progress bar showing step 3/3
- Timezone selector (auto-detect from browser, dropdown to override)
- Morning brief time picker (default 8:00 AM)
- Notification preferences:
  - New orders: on/off (default on)
  - Low inventory alerts: on/off (default on)
  - Payment failures: on/off (default on)
  - Daily summary: on/off (default on)
- Currency display preference (auto-detect from Shopify store, or override)
- "Complete Setup" button → redirects to dashboard with confetti animation 🎉

API:
- PUT /api/users/preferences — updates user timezone, brief time, notification prefs
- POST /api/jobs/setup — creates default scheduled jobs (morning brief, eod summary)
```

**Validate**: Complete full onboarding flow. Verify user preferences saved. Verify scheduled jobs created.

---

### Prompt 4.6 — Settings: Connections

```
Create apps/dashboard/src/app/(dashboard)/settings/connections/page.tsx:

UI:
- Card for each connected platform (Shopify, Xero, WhatsApp, etc.)
  - Platform icon + name
  - Connection status badge (Connected / Disconnected / Error)
  - Connected store name / phone number
  - Last synced timestamp
  - "Disconnect" button (with confirmation dialog)
  - "Reconnect" button (if expired/errored)
- "Add Connection" section at bottom with available platforms
- Each platform card links to its OAuth flow

API endpoints:
- GET /api/connections — list all connections
- DELETE /api/connections/:id — disconnect (revoke OAuth + delete record)
- POST /api/connections/:id/refresh — attempt token refresh
```

---

### Prompt 4.7 — Settings: Conversation Log

```
Create apps/dashboard/src/app/(dashboard)/settings/conversations/page.tsx:

A read-only view of the owner's conversation history with Kommand.

UI:
- Chat-style interface showing messages in chronological order
- Owner messages on the right (blue bubbles), Kommand responses on the left (gray bubbles)
- Each message shows timestamp
- Tool calls shown as collapsed sections: "📊 Called get_sales_summary" — expandable to show input/output
- Pagination: load last 50 messages, "Load more" button
- Search bar to filter by keyword

API:
- GET /api/conversations?limit=50&offset=0 — returns messages for the user
- GET /api/conversations/search?q=refund — keyword search in messages
```

---

### Prompt 4.8 — Dashboard API Routes

```
Create all remaining API routes needed by the dashboard:

apps/api/src/routes/dashboard/:

1. GET /api/me — Return current user profile + connections summary
2. PUT /api/me — Update user profile (name, timezone, preferences)
3. GET /api/connections — List all connections with status
4. DELETE /api/connections/:id — Disconnect a platform
5. GET /api/conversations — List messages with pagination
6. GET /api/conversations/search — Search messages
7. GET /api/stats/overview — Quick stats for dashboard overview (orders today, revenue, pending actions)
8. GET /api/commands — Audit log of commands (paginated, filterable by status)

All routes:
- Authenticated via Clerk (verify JWT)
- Scoped to current user (never return other users' data)
- Return consistent JSON: { success: boolean, data?: T, error?: { code, message } }
- Input validation with Zod
- Rate limited: 60 requests/minute per user
```

**Validate**: Test each endpoint with curl using a valid Clerk JWT.

---

## M5: INVOICING (XERO)

### Prompt 5.1 — Xero OAuth2 + Token Management

```
CONTEXT: apps/api/src/tools/shopify/auth.ts (pattern reference), specs/SECURITY.md

Create apps/api/src/tools/xero/auth.ts:

Xero uses OAuth2 with PKCE. Implementation:

1. routes/xero-auth.ts:
   - GET /auth/xero — Initiates Xero OAuth
     - Generate code_verifier and code_challenge (S256)
     - Store code_verifier in Redis (5 min TTL)
     - Redirect to https://login.xero.com/identity/connect/authorize with:
       - response_type=code, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method
   
   - GET /auth/xero/callback
     - Exchange code for tokens (access_token + refresh_token)
     - Fetch tenant connections (GET https://api.xero.com/connections)
     - If multiple tenants, redirect to dashboard for tenant selection
     - Encrypt and store tokens

2. tools/xero/client.ts — XeroClient:
   - constructor with encrypted tokens
   - Automatic token refresh before requests (Xero tokens expire in 30 min)
   - get(endpoint), post(endpoint, body), put(endpoint, body)
   - Base URL: https://api.xero.com/api.xro/2.0/
   - Headers: Authorization: Bearer {token}, Xero-tenant-id: {tenantId}

3. Token refresh logic:
   - Before each API call, check if token expires within 5 minutes
   - If so, refresh using refresh_token
   - Update encrypted tokens in DB
   - Use Redis lock to prevent concurrent refresh races
```

---

### Prompt 5.2 — Invoice Tools

```
Create apps/api/src/tools/xero/invoices.ts:

1. get_invoices (Tier 0):
   - Input: { status?: "DRAFT" | "SUBMITTED" | "AUTHORISED" | "PAID" | "OVERDUE" }
   - GET /Invoices?where=Status="{status}"&order=Date DESC
   - Returns: Array<{ invoiceNumber, contactName, total, amountDue, status, dueDate, isOverdue }>

2. get_invoice_details (Tier 0):
   - Input: { invoice_number: string }
   - Returns full invoice with line items

3. create_invoice (Tier 1):
   - Input: { contact_name, line_items: Array<{description, quantity, unit_amount}>, due_date?, reference? }
   - First search for contact by name (Xero contacts endpoint)
   - Create invoice as DRAFT
   - Confirmation: "Create invoice for {contact} — {total} ({itemCount} items), due {date}? (Yes/No)"

4. send_invoice (Tier 1):
   - Input: { invoice_number }
   - Sends invoice email via Xero API
   - Confirmation: "Send invoice {number} to {contact}? (Yes/No)"

5. get_overdue_invoices (Tier 0):
   - Returns all invoices past due date with days overdue calculated
   - Sorted by amount (largest first)

6. send_invoice_reminder (Tier 1):
   - Input: { invoice_number }
   - Sends reminder email via Xero
   - Confirmation: "Send payment reminder for invoice {number} ({amount} overdue by {days} days)? (Yes/No)"
```

---

### Prompt 5.3-5.5 — Bills, Reports, Dashboard Connection

```
PROMPTS 5.3, 5.4, 5.5 follow the same pattern as 5.2.

5.3 — Bills & Expenses (apps/api/src/tools/xero/bills.ts):
- get_bills_due (Tier 0): { days?: number } → upcoming bills
- approve_bill (Tier 1): { bill_id } → approve for payment
- get_expense_summary (Tier 0): { period } → categorized expense breakdown

5.4 — Reports (apps/api/src/tools/xero/reports.ts):
- get_profit_loss (Tier 0): { period } → P&L summary
- get_balance_sheet (Tier 0): → current balance sheet summary
- get_accounts_receivable (Tier 0): → total AR with aging buckets
- get_cash_summary (Tier 0): → cash across all bank accounts

5.5 — Dashboard Xero connection page:
- Same pattern as Shopify connection in settings
- Tenant picker if user has multiple Xero orgs
- Connection status + last synced
```

---

## M6: PROACTIVE INTELLIGENCE

### Prompt 6.1 — Job Scheduler

```
Install BullMQ. Create apps/api/src/jobs/scheduler.ts:

1. JobScheduler class using BullMQ with Redis:
   - registerJob(name, handler, cronExpression?)
   - For repeatable jobs: use BullMQ's repeat option with cron
   - For one-off jobs: add to queue with delay
   - Built-in retry: 3 attempts with exponential backoff
   - Dead letter queue for failed jobs
   - Job types: morning_brief, eod_summary, stock_check, invoice_reminder, alert_check

2. On API startup:
   - Load all active scheduled_jobs from DB
   - Register each with BullMQ
   - Start the worker
```

---

### Prompt 6.2 — Morning Brief

```
Create apps/api/src/jobs/handlers/morning-brief.ts:

1. generateMorningBrief(userId: string): Promise<void>
   - Fetch all connected platforms for the user
   - In parallel, gather:
     - Yesterday's sales summary (Shopify)
     - Overnight orders (since last brief)
     - Failed payments
     - Cash position (Xero if connected)
     - Low stock items
     - Overdue invoices (Xero if connected)
     - Today's schedule (bills due, etc.)
   - Compile into a structured brief
   - Format using formatMorningBrief()
   - Send via WhatsApp using the user's connected channel
   - Log as a system message in conversation

2. Schedule: runs at each user's configured morning_brief time (in their timezone)
```

---

### Prompt 6.3-6.6 — Alerts, EOD Summary, Threshold Rules, Preferences UI

```
6.3 — Real-time alert engine (webhooks from Shopify):
- Register Shopify webhooks for: orders/create, orders/cancelled, app/uninstalled
- On new order: send instant WhatsApp notification if enabled
- On low stock triggered by order: send stock alert

6.4 — End-of-day summary:
- Similar to morning brief but focuses on today's activity
- Revenue, orders, fulfillment status, any issues

6.5 — Configurable threshold alerts:
- Load alert_rules from DB
- Check thresholds periodically (every 15 min)
- Respect cooldown periods to avoid spam
- Types: inventory_low, revenue_drop, invoice_overdue

6.6 — Alert preferences UI (dashboard):
- Toggle each alert type on/off
- Set thresholds (e.g., alert when stock < X)
- Set quiet hours (don't alert between 10pm-7am)
- Preview: "This is what the alert looks like"
```

---

## M7: LAUNCH PREP

### Prompts 7.1-7.7

```
7.1 — Security hardening: implement all items from SECURITY.md that aren't already done. Audit all routes for auth, add rate limiting to all endpoints, input sanitization review.

7.2 — Encryption at rest: verify all tokens encrypted, add key rotation migration script.

7.3 — Audit logging: ensure every write command is logged. Add GET /api/audit-log endpoint for dashboard.

7.4 — Shopify App Store submission: app listing content (description, screenshots, privacy policy URL), GDPR webhooks (customers/redact, shop/redact, customers/data_request).

7.5 — Billing: Shopify Billing API for recurring charges. 14-day free trial. Plan enforcement (message limits, feature gates).

7.6 — Monitoring: Sentry error tracking in both API and dashboard. Uptime monitoring. Alert on error rate spike.

7.7 — Load testing: k6 scripts simulating 100 concurrent users. Identify and fix bottlenecks. Connection pooling optimization. Query analysis with EXPLAIN.
```

---

## Prompt Execution Checklist

After each prompt:
- [ ] Code compiles (`npx tsc --noEmit`)
- [ ] Tests pass (`npm run test`)
- [ ] Linter passes (`npm run lint`)
- [ ] Manual smoke test works
- [ ] Commit with message: `M{milestone}.{prompt}: {description}`
- [ ] Update this checklist

Total prompts: **52**
Estimated total time: **14-20 working days** with AI coding tools

---

## Tips for AI Coding Sessions

1. **Always load PROJECT_BIBLE.md as context** — it has the architecture, naming conventions, and tech stack
2. **Load the relevant spec file** for the milestone you're working on
3. **Load the previous prompt's output files** as CONTEXT when specified
4. **If a prompt produces >500 lines**, consider splitting into two prompts
5. **Test after every prompt** — don't batch multiple prompts before testing
6. **If the AI gets confused**, restart the session with fresh context
7. **Keep a CHANGELOG.md** — note deviations from the spec as you build
