import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/conversations?limit=50&offset=0 — paginated message history
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit  = searchParams.get('limit')  ?? '50';
  const offset = searchParams.get('offset') ?? '0';

  try {
    const res = await fetch(
      `${API_URL}/conversations?clerkId=${encodeURIComponent(userId)}&limit=${limit}&offset=${offset}`
    );

    const data = (await res.json()) as {
      messages: unknown[];
      total: number;
      hasMore: boolean;
      error?: string;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Failed to fetch conversations' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch conversations. Please try again.' },
      { status: 500 }
    );
  }
}
