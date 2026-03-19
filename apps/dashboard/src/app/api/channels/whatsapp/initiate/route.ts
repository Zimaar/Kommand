import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as { phoneNumber?: string };
  const phoneNumber = body.phoneNumber?.trim();

  if (!phoneNumber) {
    return NextResponse.json({ error: 'phoneNumber is required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/channels/whatsapp/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerkId: userId, phoneNumber }),
    });

    const data = (await res.json()) as { error?: string; success?: boolean };

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error ?? 'Failed to send verification code' },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'Failed to send verification code. Please try again.' },
      { status: 500 }
    );
  }
}
