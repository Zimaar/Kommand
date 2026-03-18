import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// Simple in-memory rate limiter for OAuth initiation (per minute per user)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    // Reset or create new entry: max 5 attempts per minute
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }

  if (entry.count >= 5) {
    return false; // Rate limited
  }

  entry.count++;
  return true;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate limit: max 5 OAuth initiations per minute per user
  if (!checkRateLimit(userId)) {
    return NextResponse.json(
      { error: 'Too many connection attempts. Please try again in a minute.' },
      { status: 429 }
    );
  }

  const body = (await request.json()) as { storeUrl?: string };
  const storeUrl = body.storeUrl?.trim();

  if (!storeUrl) {
    return NextResponse.json({ error: 'Store URL is required' }, { status: 400 });
  }

  // Normalize: accept "mystore" or "mystore.myshopify.com"
  const shopDomain = storeUrl.includes('.myshopify.com')
    ? storeUrl
    : `${storeUrl}.myshopify.com`;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return NextResponse.json({ error: 'Invalid Shopify store URL' }, { status: 400 });
  }

  // Check if store is already connected by another account
  try {
    const checkRes = await fetch(`${API_URL}/connections/shopify/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopDomain }),
    });

    if (!checkRes.ok) {
      const data = (await checkRes.json()) as { error?: string };
      return NextResponse.json({ error: data.error ?? 'Store already connected' }, { status: 409 });
    }
  } catch {
    return NextResponse.json(
      { error: 'Failed to validate store availability' },
      { status: 500 }
    );
  }

  // Construct OAuth URL and redirect client-side (prevents CORS issues)
  // Client will handle the actual redirect to Shopify
  const oauthUrl = `${API_URL}/auth/shopify?shop=${encodeURIComponent(shopDomain)}&userId=${encodeURIComponent(userId)}&redirectUrl=${encodeURIComponent(new URL(request.url).origin)}/onboarding?shopify=connected`;

  return NextResponse.json({ url: oauthUrl });
}
