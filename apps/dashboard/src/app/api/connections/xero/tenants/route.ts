import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/connections/xero/tenants?pendingId=...
// Proxies to backend GET /auth/xero/pending-tenants to retrieve the tenant list
// for a multi-tenant Xero OAuth session.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pendingId = searchParams.get('pendingId');

  if (!pendingId) {
    return NextResponse.json({ error: 'pendingId is required' }, { status: 400 });
  }

  const res = await fetch(
    `${API_URL}/auth/xero/pending-tenants?pendingId=${encodeURIComponent(pendingId)}`
  );
  const json = (await res.json()) as unknown;
  return NextResponse.json(json, { status: res.status });
}

// POST /api/connections/xero/tenants
// Proxies to backend POST /auth/xero/select-tenant to complete tenant selection.
export async function POST(request: Request) {
  const body = (await request.json()) as { pendingId?: string; tenantId?: string };

  const res = await fetch(`${API_URL}/auth/xero/select-tenant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  return NextResponse.json(json, { status: res.status });
}
