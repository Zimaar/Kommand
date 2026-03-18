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

      const data = (await res.json()) as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  }

  function handleSkip() {
    router.push('/onboarding?step=2');
  }

  function handleNext() {
    router.push('/onboarding?step=2');
  }

  // Only show step 1 for now — steps 2 and 3 are placeholders for future prompts
  if (currentStep !== 1) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center">
        <ProgressBar current={currentStep} />
        <div className="mt-12 rounded-2xl border bg-card p-8">
          <p className="text-muted-foreground">
            {currentStep === 2
              ? 'Connect WhatsApp — coming in Prompt 4.4'
              : 'Preferences — coming in Prompt 4.5'}
          </p>
          <Button
            variant="outline"
            className="mt-6"
            onClick={() =>
              currentStep === 2
                ? router.push('/onboarding?step=3')
                : router.push('/overview')
            }
          >
            {currentStep === 2 ? 'Next' : 'Finish'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-12">
      <ProgressBar current={1} />

      <div className="mt-12 rounded-2xl border bg-card p-8">
        {/* Shopify icon */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#95BF47]/10">
            <ShoppingBag className="h-8 w-8 text-[#95BF47]" />
          </div>
        </div>

        <h2 className="mb-2 text-center text-xl font-semibold">
          Connect your Shopify store
        </h2>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          Link your store so Kommand can manage orders, products, and customers
          for you.
        </p>

        {checkingConnection ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isConnected ? (
          /* Connected state */
          <div className="space-y-6">
            <div className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/30">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
                <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-green-800 dark:text-green-300">
                  {connection?.shopName ?? connection?.shopDomain ?? 'Store'}{' '}
                  connected
                </p>
                {connection?.shopDomain && (
                  <p className="text-sm text-green-600 dark:text-green-500">
                    {connection.shopDomain}
                  </p>
                )}
              </div>
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                Connected
              </span>
            </div>

            <Button className="w-full gap-2" onClick={handleNext}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          /* Connect form */
          <div className="space-y-4">
            <div>
              <Label htmlFor="store-url" className="mb-1.5">
                Store URL
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="store-url"
                  placeholder="mystore"
                  value={storeUrl}
                  onChange={(e) => {
                    setStoreUrl(e.target.value);
                    setError('');
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                  className="flex-1"
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  .myshopify.com
                </span>
              </div>
              {error && (
                <p className="mt-1.5 text-sm text-destructive">{error}</p>
              )}
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleConnect}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Connecting...
                </>
              ) : (
                <>
                  <ShoppingBag className="h-4 w-4" /> Connect Shopify
                </>
              )}
            </Button>

            <button
              type="button"
              onClick={handleSkip}
              className="w-full text-center text-sm text-muted-foreground transition hover:text-foreground"
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ current }: { current: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Step {current} of 3</span>
        <span className="text-muted-foreground">{STEPS[current - 1]}</span>
      </div>
      <div className="flex gap-2">
        {[1, 2, 3].map((step) => (
          <div
            key={step}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              step <= current ? 'bg-primary' : 'bg-muted'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
