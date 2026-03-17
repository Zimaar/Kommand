# API DESIGN — Technical Spec

## Base URL
- Development: `http://localhost:3000`
- Production: `https://api.kommand.dev`

## Authentication
- Dashboard routes: Clerk JWT in `Authorization: Bearer {token}` header
- Webhook routes: Platform-specific signature verification (no JWT)
- Internal routes: Service key in `X-Service-Key` header

## Response Format
All endpoints return:
```json
{
  "success": true,
  "data": { ... },
  "meta": { "page": 1, "total": 100, "hasMore": true }
}
```
Or on error:
```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Order identifier is required" }
}
```

## Rate Limits
- Dashboard API: 60 req/min per user
- Webhook ingestion: 1000 req/min per IP
- AI processing: 30 Claude calls/hr per user

---

## Endpoints

### Webhooks (Unauthenticated — signature verified)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/webhook/whatsapp` | Meta verification challenge |
| POST | `/webhook/whatsapp` | Inbound WhatsApp messages |
| POST | `/webhook/shopify` | Shopify event webhooks (orders, inventory) |
| POST | `/webhook/xero` | Xero event webhooks |
| POST | `/webhook/clerk` | Clerk auth events (user created, updated) |

### Auth / OAuth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/shopify` | Initiate Shopify OAuth |
| GET | `/auth/shopify/callback` | Shopify OAuth callback |
| GET | `/auth/xero` | Initiate Xero OAuth |
| GET | `/auth/xero/callback` | Xero OAuth callback |

### Dashboard API (Clerk JWT required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Current user profile + connection summary |
| PUT | `/api/me` | Update profile (name, timezone, preferences) |
| GET | `/api/connections` | List all platform connections |
| DELETE | `/api/connections/:id` | Disconnect a platform |
| POST | `/api/connections/:id/refresh` | Refresh OAuth token |
| GET | `/api/conversations` | Message history (paginated) |
| GET | `/api/conversations/search` | Search messages by keyword |
| GET | `/api/stats/overview` | Quick stats for dashboard |
| GET | `/api/commands` | Audit log of executed commands |
| GET | `/api/alerts` | List alert rules |
| POST | `/api/alerts` | Create alert rule |
| PUT | `/api/alerts/:id` | Update alert rule |
| DELETE | `/api/alerts/:id` | Delete alert rule |
| PUT | `/api/preferences` | Update notification preferences |
| POST | `/api/channels/whatsapp/initiate` | Start WhatsApp verification |
| POST | `/api/channels/whatsapp/verify` | Complete WhatsApp verification |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | API health check |
| GET | `/health/db` | Database connectivity check |
| GET | `/health/redis` | Redis connectivity check |

---

## Shopify GraphQL Queries Reference

### Orders Summary
```graphql
query OrdersSummary($query: String!) {
  orders(first: 250, query: $query) {
    edges {
      node {
        id
        name
        totalPriceSet { shopMoney { amount currencyCode } }
        createdAt
        displayFulfillmentStatus
        displayFinancialStatus
        customer { firstName lastName email }
        lineItems(first: 5) {
          edges { node { title quantity } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### Refund Mutation
```graphql
mutation RefundCreate($input: RefundInput!) {
  refundCreate(input: $input) {
    refund {
      id
      totalRefundedSet { shopMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}
```

### Product Search
```graphql
query Products($query: String, $first: Int!) {
  products(first: $first, query: $query) {
    edges {
      node {
        id
        title
        status
        totalInventory
        variants(first: 10) {
          edges {
            node {
              id
              title
              price
              inventoryQuantity
              sku
            }
          }
        }
      }
    }
  }
}
```

---

## Xero API Endpoints Reference

| Xero Endpoint | Kommand Tool | Method |
|---------------|-------------|--------|
| `/Invoices` | get_invoices, create_invoice | GET, POST |
| `/Invoices/{id}` | get_invoice_details | GET |
| `/Invoices/{id}/Email` | send_invoice | POST |
| `/Contacts` | search contacts | GET |
| `/BankTransactions` | get_expense_summary | GET |
| `/Reports/ProfitAndLoss` | get_profit_loss | GET |
| `/Reports/BalanceSheet` | get_balance_sheet | GET |
| `/Accounts` | get_cash_summary | GET |

All Xero endpoints require:
- `Authorization: Bearer {access_token}`
- `Xero-tenant-id: {tenant_id}`
- `Content-Type: application/json`
