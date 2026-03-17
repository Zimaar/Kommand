# KOMMAND — Project Bible

> **"Your business, as a conversation."**
> An AI-powered conversational control plane that lets e-commerce and small business owners manage their entire operation via WhatsApp, Slack, Email, or any messaging channel.

---

## How to Use This Document

This project is designed to be **built entirely with AI coding tools** (Claude Code, GPT Codex, Cursor, etc.). Every document in this repo follows these principles:

1. **Each milestone folder contains numbered, one-shottable prompts** — copy-paste them into your AI coding tool in order
2. **Each prompt produces a single testable unit** — one file or one tightly-coupled set of files (~200-500 lines max)
3. **Context files are marked** — when a prompt needs prior code as context, it says `CONTEXT: [filename]`
4. **Validation steps are included** — every prompt ends with a test command or manual check
5. **The PROJECT_BIBLE.md (this file) should be loaded as system context** for every coding session

---

## Product Vision

### The Problem
Small business owners juggle 6-12 SaaS tools daily. They spend 2-3 hours/day rotating through dashboards just to maintain situational awareness. When away from a screen, they're flying blind.

### The Solution
Kommand turns the owner's existing messaging app (WhatsApp, Slack, etc.) into a unified command center for their entire business. They can ask questions, issue commands, and receive proactive intelligence — all through natural conversation.

### The USP (3 pillars)
1. **Bidirectional control** — not just monitoring. Ask, command, decide, act.
2. **Cross-platform orchestration** — one message queries Shopify + Xero + Stripe simultaneously
3. **Proactive co-pilot** — AI initiates conversations when it spots opportunities or risks

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Runtime** | Node.js 20 + TypeScript 5 | Largest AI training corpus, best async I/O for webhooks |
| **Framework** | Fastify | 2x faster than Express, schema validation built-in, great TypeScript |
| **Database** | PostgreSQL 16 (via Supabase) | JSONB for flexible tool responses, row-level security |
| **Cache/Queue** | Redis (Upstash) | Message dedup, rate limiting, job queues |
| **AI/NLP** | Anthropic Claude API (claude-sonnet-4-20250514) | Best instruction following for structured tool use |
| **Message Channel** | WhatsApp Cloud API (Meta) | 2B+ users, richest business API, free tier available |
| **E-commerce** | Shopify Admin API (GraphQL) | Largest merchant base, best API docs |
| **Invoicing** | Xero API | Strong in MENA/APAC/UK, good OAuth2 flow |
| **Payments** | Stripe API | Universal, great webhooks |
| **Web Dashboard** | Next.js 14 (App Router) + Tailwind + shadcn/ui | Fast to ship, great DX, SSR for onboarding |
| **Auth** | Clerk | Handles OAuth2 for all providers, webhook events |
| **Hosting** | Railway (API) + Vercel (Dashboard) | Simple deploys, good free tiers |
| **Monitoring** | Sentry + Axiom | Error tracking + structured logging |
| **CI/CD** | GitHub Actions | Standard, free for public repos |

### Why This Stack
- **TypeScript everywhere** = one language, AI tools write it best
- **Supabase** = Postgres + Auth + Realtime + Storage in one, generous free tier
- **Railway** = long-running processes (webhook listeners), unlike Vercel serverless
- **Fastify** = schema-first API design maps perfectly to AI prompt specs

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    MESSAGING CHANNELS                      │
│  WhatsApp Cloud API  │  Slack Bot  │  Email (SendGrid)    │
└──────────┬───────────┴──────┬──────┴──────────┬───────────┘
           │                  │                  │
           ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│              CHANNEL ADAPTER LAYER (normalize)             │
│  Converts each channel's format → unified InboundMessage   │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    KOMMAND CORE ENGINE                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Auth &       │  │ AI Brain     │  │ Action Router   │  │
│  │ Permissions  │  │ (Claude API) │  │ (tool dispatch) │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Context      │  │ Confirmation │  │ Response        │  │
│  │ Manager      │  │ Engine       │  │ Formatter       │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                  TOOL INTEGRATION LAYER                     │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │
│  │ Shopify  │ │ Xero     │ │ Stripe │ │ Shipping     │  │
│  │ Adapter  │ │ Adapter  │ │ Adapter│ │ Adapter      │  │
│  └──────────┘ └──────────┘ └────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Channel-agnostic core**: The AI brain never knows which channel the message came from. Channel adapters normalize everything into `InboundMessage` and format responses back via `OutboundMessage`.

2. **Tool-use pattern for AI**: We use Claude's native tool_use/function-calling. Each integration (Shopify, Xero, etc.) registers as a set of "tools" the AI can call. The AI decides which tools to invoke based on the owner's natural language.

3. **Confirmation tiers**: Actions are classified into tiers:
   - **Tier 0 (Read)**: No confirmation. "What are today's sales?"
   - **Tier 1 (Low-risk write)**: Inline confirmation. "Send invoice?" → [Yes/No]
   - **Tier 2 (Medium-risk)**: Confirmation with preview. "Refund $145 to Ahmed?" → shows details
   - **Tier 3 (High-risk)**: Double confirmation. "Change all prices by 20%?" → "Are you sure? This affects 47 products."

4. **Idempotency everywhere**: Every command gets a unique `command_id`. If the owner sends the same message twice, it deduplicates. If a tool call fails mid-execution, it can retry safely.

---

## Repository Structure

```
kommand/
├── PROJECT_BIBLE.md              ← You are here (load as context always)
├── ROADMAP.md                    ← Phase overview + timeline
├── package.json
├── tsconfig.json
├── .env.example
├── docker-compose.yml            ← Local Postgres + Redis
│
├── apps/
│   ├── api/                      ← Fastify API server (Railway)
│   │   ├── src/
│   │   │   ├── index.ts          ← Server entry
│   │   │   ├── config/           ← Environment, constants
│   │   │   ├── channels/         ← WhatsApp, Slack, Email adapters
│   │   │   ├── core/             ← AI brain, router, confirmation
│   │   │   ├── tools/            ← Shopify, Xero, Stripe tool definitions
│   │   │   ├── services/         ← Business logic layer
│   │   │   ├── db/               ← Drizzle ORM schemas + migrations
│   │   │   ├── jobs/             ← Background jobs (proactive alerts, summaries)
│   │   │   ├── middleware/       ← Auth, rate limiting, logging
│   │   │   └── utils/            ← Shared helpers
│   │   ├── tests/
│   │   └── package.json
│   │
│   └── dashboard/                ← Next.js web app (Vercel)
│       ├── src/
│       │   ├── app/              ← App Router pages
│       │   ├── components/       ← React components
│       │   ├── lib/              ← API client, auth helpers
│       │   └── styles/
│       └── package.json
│
├── packages/
│   └── shared/                   ← Shared types, constants, validation schemas
│       ├── src/
│       │   ├── types/            ← InboundMessage, OutboundMessage, ToolResult, etc.
│       │   ├── schemas/          ← Zod schemas for validation
│       │   └── constants/        ← Tier definitions, error codes
│       └── package.json
│
├── docs/                         ← This documentation folder
│   ├── milestones/               ← Detailed milestone specs
│   ├── specs/                    ← Technical specs (DB, API, Security)
│   └── prompts/                  ← One-shottable AI coding prompts
│
└── scripts/                      ← DB seeds, dev utilities
```

---

## Milestone Summary

| # | Milestone | Deliverable | Prompts | Est. Time |
|---|-----------|-------------|---------|-----------|
| M0 | Project Setup | Monorepo, DB, Docker, CI | 6 | 1 day |
| M1 | Core Engine | AI brain, message routing, tool dispatch | 8 | 2-3 days |
| M2 | Shopify Integration | Full Shopify read/write tools | 7 | 2-3 days |
| M3 | WhatsApp Channel | Cloud API webhook, send/receive | 5 | 1-2 days |
| M4 | Web Dashboard | Onboarding, OAuth, settings | 8 | 2-3 days |
| M5 | Invoicing (Xero) | Xero read/write tools | 5 | 1-2 days |
| M6 | Proactive Intelligence | Scheduled briefs, alerts, predictions | 6 | 2-3 days |
| M7 | Launch Prep | Security hardening, Shopify app submission, polish | 7 | 2-3 days |
| **Total** | | | **52 prompts** | **~14-20 days** |

---

## Key Conventions for AI Coding

### TypeScript Style
- Strict mode always (`"strict": true`)
- Explicit return types on all exported functions
- Zod for runtime validation, infer types from schemas
- No `any` — use `unknown` + type guards
- Barrel exports from each module's `index.ts`

### Naming
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Database tables: `snake_case`
- API routes: `kebab-case`

### Error Handling
- Custom `AppError` class with error codes
- All tool calls wrapped in try/catch with structured error responses
- Never throw raw strings
- Errors logged to Sentry, user gets friendly message via chat

### Testing
- Vitest for unit tests
- Each tool adapter has mock fixtures
- Integration tests use Supabase local (via Docker)
- Minimum: every tool function has ≥1 happy path + ≥1 error test

---

## Environment Variables

```env
# Core
NODE_ENV=development
PORT=3000
API_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3001

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kommand
REDIS_URL=redis://localhost:6379

# AI
ANTHROPIC_API_KEY=sk-ant-...

# WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=kommand-verify-2024
WHATSAPP_APP_SECRET=

# Shopify
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_SCOPES=read_orders,write_orders,read_products,write_products,read_inventory,write_inventory,read_customers

# Xero
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=http://localhost:3001/api/auth/xero/callback

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Auth (Clerk)
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# Monitoring
SENTRY_DSN=
AXIOM_TOKEN=
```
