import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// POST /api/connections/:id/refresh — attempt token refresh / re-validation
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const res = await fetch(`${API_URL}/connections/${id}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerkId: userId }),
    });

    const data = (await res.json()) as {
      error?: string;
      refreshed?: boolean;
      requiresReconnect?: boolean;
      platform?: string;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Failed to refresh connection' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'Failed to refresh connection. Please try again.' },
      { status: 500 }
    );
  }
}
