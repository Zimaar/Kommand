import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/me — current user profile + connections summary
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  try {
    const res  = await fetch(`${API_URL}/me?clerkId=${encodeURIComponent(userId)}`);
    const data = await res.json() as unknown;

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch profile. Please try again.' } },
      { status: 500 }
    );
  }
}

// PUT /api/me — update name / timezone
export async function PUT(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  const body = (await request.json()) as Record<string, unknown>;

  try {
    const res  = await fetch(`${API_URL}/me`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...body, clerkId: userId }),
    });
    const data = await res.json() as unknown;

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update profile. Please try again.' } },
      { status: 500 }
    );
  }
}
