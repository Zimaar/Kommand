import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/commands?status=pending&limit=50&offset=0 — paginated command audit log
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const params = new URLSearchParams({ clerkId: userId });

  const status = searchParams.get('status');
  const limit  = searchParams.get('limit')  ?? '50';
  const offset = searchParams.get('offset') ?? '0';

  if (status) params.set('status', status);
  params.set('limit',  limit);
  params.set('offset', offset);

  try {
    const res  = await fetch(`${API_URL}/commands?${params.toString()}`);
    const data = await res.json() as unknown;

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch commands. Please try again.' } },
      { status: 500 }
    );
  }
}
