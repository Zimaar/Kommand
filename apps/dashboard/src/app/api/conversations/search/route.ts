import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/conversations/search?q=refund — keyword search in message content
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? '';

  try {
    const res = await fetch(
      `${API_URL}/conversations/search?clerkId=${encodeURIComponent(userId)}&q=${encodeURIComponent(q)}`
    );

    const data = (await res.json()) as {
      messages: unknown[];
      error?: string;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Failed to search conversations' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'Failed to search conversations. Please try again.' },
      { status: 500 }
    );
  }
}
