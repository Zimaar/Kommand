import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const res = await fetch(`${API_URL}/connections?clerkId=${encodeURIComponent(userId)}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to fetch connections' }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
