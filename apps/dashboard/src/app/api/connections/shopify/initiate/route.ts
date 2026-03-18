import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  // Return the OAuth initiation URL — the API server handles the redirect to Shopify
  const oauthUrl = `${API_URL}/auth/shopify?shop=${encodeURIComponent(shopDomain)}&userId=${encodeURIComponent(userId)}`;

  return NextResponse.json({ url: oauthUrl });
}
