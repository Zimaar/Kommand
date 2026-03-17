# KOMMAND — Project Documentation

> **"Your business, as a conversation."**

## Quick Start
1. Read `PROJECT_BIBLE.md` first — vision, architecture, tech stack, conventions
2. Check `ROADMAP.md` for phases, timeline, pricing
3. Open `prompts/ALL_PROMPTS.md` and start executing the 52 prompts in order

## File Map

| File | What It Contains |
|------|-----------------|
| `PROJECT_BIBLE.md` | **Start here.** Vision, USP, tech stack, architecture, repo structure, conventions, all 7 milestones with prompt counts |
| `ROADMAP.md` | Phase overview + post-launch roadmap reference |
| `specs/DATABASE_SCHEMA.md` | All PostgreSQL tables, columns, indexes, RLS, encryption notes |
| `specs/AI_BRAIN_PROMPT.md` | The Claude system prompt, tool registry, context injection, response formatting |
| `specs/API_DESIGN.md` | All HTTP endpoints, response formats, Shopify GraphQL queries, Xero endpoints |
| `specs/SECURITY.md` | Encryption, webhook verification, rate limiting, prompt injection defense, GDPR |
| `prompts/ALL_PROMPTS.md` | **The build guide.** 52 copy-pasteable prompts organized by milestone (M0-M7) |

## Using with AI Coding Tools

Load `PROJECT_BIBLE.md` as permanent context. Then execute prompts from `ALL_PROMPTS.md` one at a time, including any CONTEXT files each prompt specifies. Test after every prompt. Commit after every success.

## Stats
- **52 prompts** across 7 milestones
- **~14-20 working days** estimated build time with AI tools
- **V1 scope**: WhatsApp + Shopify + basic Xero + proactive briefs
