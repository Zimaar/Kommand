# DATABASE SCHEMA — Technical Spec

> PostgreSQL via Supabase. ORM: Drizzle. All timestamps are UTC.

---

## Tables

### `users`
The Kommand account holder (business owner).

```sql
users
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── clerk_id        TEXT UNIQUE NOT NULL        -- Clerk auth user ID
├── email           TEXT UNIQUE NOT NULL
├── name            TEXT
├── phone           TEXT                        -- WhatsApp number (E.164 format)
├── timezone        TEXT DEFAULT 'UTC'
├── morning_brief   TIME DEFAULT '08:00'        -- When to send daily brief
├── plan            TEXT DEFAULT 'trial'         -- trial | starter | growth | pro
├── plan_expires_at TIMESTAMPTZ
├── created_at      TIMESTAMPTZ DEFAULT now()
└── updated_at      TIMESTAMPTZ DEFAULT now()
```

### `stores`
A connected e-commerce store (Shopify, WooCommerce, etc.).

```sql
stores
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── platform        TEXT NOT NULL               -- shopify | woocommerce | bigcommerce
├── shop_domain     TEXT NOT NULL               -- mystore.myshopify.com
├── shop_name       TEXT
├── access_token    TEXT NOT NULL               -- ENCRYPTED (AES-256-GCM)
├── token_iv        TEXT NOT NULL               -- Initialization vector for decryption
├── scopes          TEXT[]                      -- Granted OAuth scopes
├── is_active       BOOLEAN DEFAULT true
├── installed_at    TIMESTAMPTZ DEFAULT now()
├── last_synced_at  TIMESTAMPTZ
├── created_at      TIMESTAMPTZ DEFAULT now()
└── updated_at      TIMESTAMPTZ DEFAULT now()

UNIQUE(user_id, platform, shop_domain)
```

### `accounting_connections`
Connected invoicing/bookkeeping tools (Xero, QuickBooks, FreshBooks).

```sql
accounting_connections
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── platform        TEXT NOT NULL               -- xero | quickbooks | freshbooks
├── tenant_id       TEXT                        -- Xero org ID or QB realm ID
├── tenant_name     TEXT
├── access_token    TEXT NOT NULL               -- ENCRYPTED
├── refresh_token   TEXT NOT NULL               -- ENCRYPTED
├── token_iv        TEXT NOT NULL
├── token_expires_at TIMESTAMPTZ
├── scopes          TEXT[]
├── is_active       BOOLEAN DEFAULT true
├── created_at      TIMESTAMPTZ DEFAULT now()
└── updated_at      TIMESTAMPTZ DEFAULT now()

UNIQUE(user_id, platform, tenant_id)
```

### `channels`
Connected messaging channels per user.

```sql
channels
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── type            TEXT NOT NULL               -- whatsapp | slack | email | telegram
├── channel_id      TEXT NOT NULL               -- WhatsApp phone number ID, Slack channel, etc.
├── config          JSONB DEFAULT '{}'          -- Channel-specific config
├── is_active       BOOLEAN DEFAULT true
├── created_at      TIMESTAMPTZ DEFAULT now()
└── updated_at      TIMESTAMPTZ DEFAULT now()

UNIQUE(user_id, type, channel_id)
```

### `conversations`
A conversation thread between owner and Kommand.

```sql
conversations
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── channel_id      UUID NOT NULL REFERENCES channels(id)
├── started_at      TIMESTAMPTZ DEFAULT now()
├── last_message_at TIMESTAMPTZ DEFAULT now()
└── metadata        JSONB DEFAULT '{}'
```

### `messages`
Individual messages in a conversation.

```sql
messages
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
├── direction       TEXT NOT NULL               -- inbound | outbound
├── role            TEXT NOT NULL               -- user | assistant | system
├── content         TEXT NOT NULL               -- Raw message text
├── channel_message_id TEXT                     -- WhatsApp message ID for dedup
├── tool_calls      JSONB                       -- Tool calls made by AI (if any)
├── tool_results    JSONB                       -- Results from tool calls (if any)
├── tokens_used     INTEGER                     -- Claude tokens consumed
├── latency_ms      INTEGER                     -- Time from receive to send
├── created_at      TIMESTAMPTZ DEFAULT now()

INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC)
INDEX idx_messages_dedup ON messages(channel_message_id) WHERE channel_message_id IS NOT NULL
```

### `commands`
Every action command issued by the owner (for audit trail).

```sql
commands
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── message_id      UUID REFERENCES messages(id)
├── command_type    TEXT NOT NULL               -- refund | fulfill | create_invoice | update_price | etc.
├── tool_name       TEXT NOT NULL               -- The tool that was called
├── input           JSONB NOT NULL              -- Parameters sent to the tool
├── output          JSONB                       -- Result from the tool
├── status          TEXT DEFAULT 'pending'      -- pending | confirmed | executed | failed | cancelled
├── confirmation_tier INTEGER DEFAULT 0         -- 0=none, 1=quick, 2=preview, 3=double
├── confirmed_at    TIMESTAMPTZ
├── executed_at     TIMESTAMPTZ
├── error           TEXT
├── idempotency_key TEXT UNIQUE                 -- For safe retries
├── created_at      TIMESTAMPTZ DEFAULT now()

INDEX idx_commands_user ON commands(user_id, created_at DESC)
INDEX idx_commands_status ON commands(status) WHERE status = 'pending'
```

### `pending_confirmations`
Commands waiting for owner to confirm.

```sql
pending_confirmations
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── command_id      UUID NOT NULL REFERENCES commands(id) ON DELETE CASCADE
├── channel_id      UUID NOT NULL REFERENCES channels(id)
├── prompt_text     TEXT NOT NULL               -- "Refund $145 to Ahmed. Confirm?"
├── expires_at      TIMESTAMPTZ NOT NULL        -- Auto-cancel after 10 min
├── status          TEXT DEFAULT 'pending'      -- pending | confirmed | cancelled | expired
├── created_at      TIMESTAMPTZ DEFAULT now()

INDEX idx_pending_user ON pending_confirmations(user_id) WHERE status = 'pending'
```

### `scheduled_jobs`
Recurring proactive jobs (morning briefs, alerts).

```sql
scheduled_jobs
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── job_type        TEXT NOT NULL               -- morning_brief | eod_summary | stock_check | invoice_reminder
├── cron_expression TEXT NOT NULL               -- "0 8 * * *" (8am daily)
├── config          JSONB DEFAULT '{}'          -- Job-specific config
├── is_active       BOOLEAN DEFAULT true
├── last_run_at     TIMESTAMPTZ
├── next_run_at     TIMESTAMPTZ
├── created_at      TIMESTAMPTZ DEFAULT now()

INDEX idx_jobs_next_run ON scheduled_jobs(next_run_at) WHERE is_active = true
```

### `alert_rules`
Owner-configured threshold alerts.

```sql
alert_rules
├── id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
├── user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
├── name            TEXT NOT NULL               -- "Low stock alert"
├── type            TEXT NOT NULL               -- inventory_low | revenue_drop | invoice_overdue | custom
├── condition       JSONB NOT NULL              -- {"metric": "inventory", "product_id": "xxx", "threshold": 5, "operator": "lt"}
├── message_template TEXT                       -- Custom message template
├── is_active       BOOLEAN DEFAULT true
├── last_triggered_at TIMESTAMPTZ
├── cooldown_minutes INTEGER DEFAULT 60         -- Don't re-trigger within this window
├── created_at      TIMESTAMPTZ DEFAULT now()
```

---

## Indexes Strategy

- Every `user_id` FK gets an index (multi-tenant queries)
- `messages` has composite index on `(conversation_id, created_at DESC)` for chat history
- `commands` indexed on `(user_id, created_at DESC)` for audit log
- `pending_confirmations` partial index on `status = 'pending'` for fast lookup
- `scheduled_jobs` partial index on `next_run_at WHERE is_active` for job scheduler

## Row-Level Security (Supabase)

Every table with `user_id` gets RLS policy:
```sql
CREATE POLICY "Users can only access their own data"
ON table_name FOR ALL
USING (user_id = auth.uid());
```

The API server uses a service role key (bypasses RLS) but validates user ownership in application code.

## Encryption

OAuth tokens (`access_token`, `refresh_token`) are encrypted at rest using AES-256-GCM:
- Encryption key stored in environment variable `ENCRYPTION_KEY` (32-byte hex)
- Each token has its own IV stored in `token_iv` column
- Decrypt only when making API calls, never expose in logs or responses
