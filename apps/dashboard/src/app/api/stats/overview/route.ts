import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// GET /api/stats/overview — orders today, revenue today, pending actions, active connections
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, { status: 401 });
  }

  try {
    const res  = await fetch(`${API_URL}/stats/overview?clerkId=${encodeURIComponent(userId)}`);
    const data = await res.json() as unknown;

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch stats. Please try again.' } },
      { status: 500 }
    );
  }
}
