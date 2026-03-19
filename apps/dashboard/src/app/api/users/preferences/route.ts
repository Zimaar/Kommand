import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function PUT(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as Record<string, unknown>;

  try {
    const res = await fetch(`${API_URL}/users/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, clerkId: userId }),
    });

    const data = (await res.json()) as { error?: string };

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Failed to save preferences' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'Failed to save preferences. Please try again.' },
      { status: 500 }
    );
  }
}
