'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShoppingBag, Check, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ShopifyConnection {
  id: string;
  shopDomain: string;
  shopName: string | null;
  isActive: boolean;
}

interface ConnectionsResponse {
  shopify: ShopifyConnection | null;
  accounting: unknown;
  channels: unknown[];
}

const STEPS = ['Connect Shopify', 'Connect WhatsApp', 'Preferences'];

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <OnboardingContent />
    </Suspense>
  );
}

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const stepParam = searchParams.get('step');
  const shopifyParam = searchParams.get('shopify');
  const currentStep = stepParam ? Math.min(Math.max(parseInt(stepParam, 10), 1), 3) : 1;

  const [storeUrl, setStoreUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<ShopifyConnection | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/connections');
      if (res.ok) {
        const data = (await res.json()) as ConnectionsResponse;
        if (data.shopify) setConnection(data.shopify);
      }
    } catch {
      // Ignore — will show connect form
    } finally {
      setCheckingConnection(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // If redirected back from OAuth with shopify=connected, refresh connections
  useEffect(() => {
    if (shopifyParam === 'connected') {
      fetchConnections();
    }
  }, [shopifyParam, fetchConnections]);

  const isConnected = !!connection || shopifyParam === 'connected';

  async function handleConnect() {
    const trimmed = storeUrl.trim();
    if (!trimmed) {
      setError('Please enter your store URL');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/connections/shopify/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeUrl: trimmed }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to initiate connection');
      }

      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  function handleSkip() {
    if (currentStep === 1) {
      router.push('/onboarding/whatsapp');
    } else {
      router.push(`/onboarding?step=${currentStep + 1}`);
    }
  }

  function handleBack() {
    if (currentStep > 1) {
      router.push(`/onboarding?step=${currentStep - 1}`);
    }
  }

  // Step 1: Connect Shopify
  if (currentStep === 1) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-background px-6">
        <div className="w-full max-w-md">
          {/* Progress bar */}
          <div className="mb-8 flex gap-2">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full ${i < currentStep ? 'bg-primary' : 'bg-muted'}`}
              />
            ))}
          </div>

          {/* Header */}
          <div className="mb-8">
            <div className="mb-3 flex items-center gap-3">
              <ShoppingBag className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Connect Shopify</h1>
            </div>
            <p className="text-muted-foreground">
              Link your Shopify store to get started with Kommand.
            </p>
          </div>

          {checkingConnection ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isConnected ? (
            // Connected state
            <div className="rounded-lg border border-green-200 bg-green-50 p-6 dark:border-green-900 dark:bg-green-950">
              <div className="mb-4 flex items-start gap-3">
                <Check className="mt-1 h-5 w-5 text-green-600 dark:text-green-400" />
                <div>
                  <h3 className="font-semibold text-green-900 dark:text-green-200">
                    Store Connected
                  </h3>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    {connection?.shopName || connection?.shopDomain}
                  </p>
                </div>
              </div>
              <Button onClick={() => router.push('/onboarding/whatsapp')} className="w-full">
                Continue <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          ) : (
            // Connect form
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleConnect();
              }}
              className="space-y-4"
            >
              <div>
                <Label htmlFor="store-url">Your Shopify Store URL</Label>
                <Input
                  id="store-url"
                  placeholder="mystore or mystore.myshopify.com"
                  value={storeUrl}
                  onChange={(e) => {
                    setStoreUrl(e.target.value);
                    setError('');
                  }}
                  disabled={loading}
                />
                {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    Connect Store
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleSkip}
                disabled={loading}
              >
                Skip for now
              </Button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // Step 2 & 3: Placeholder pages
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Step {currentStep}: {STEPS[currentStep - 1]}</h1>
        <p className="mt-2 text-muted-foreground">Coming soon</p>

        <div className="mt-8 flex gap-3">
          {currentStep > 1 && (
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
          )}
          <Button onClick={handleSkip}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
