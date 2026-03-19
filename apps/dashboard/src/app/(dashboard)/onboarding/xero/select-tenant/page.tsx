'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { BookOpen, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Tenant {
  id: string;
  name: string;
}

// ─── Inner component (needs Suspense for useSearchParams) ─────────────────────

function SelectTenantContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pendingId = searchParams.get('pendingId') ?? '';

  const [tenants,    setTenants]    = useState<Tenant[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!pendingId) {
      setError('Missing session token. Please restart the Xero connection.');
      setLoading(false);
      return;
    }

    fetch(`/api/connections/xero/tenants?pendingId=${encodeURIComponent(pendingId)}`)
      .then((r) => r.json())
      .then((data: { tenants?: Tenant[]; error?: string }) => {
        if (data.error) throw new Error(data.error);
        const list = data.tenants ?? [];
        setTenants(list);
        // Auto-select if only one (shouldn't happen — backend auto-selects — but defensive)
        if (list.length === 1) setSelectedId(list[0]!.id);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load organisations');
      })
      .finally(() => setLoading(false));
  }, [pendingId]);

  async function handleConnect() {
    if (!selectedId || connecting) return;
    setConnecting(true);
    setError('');
    try {
      const res = await fetch('/api/connections/xero/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingId, tenantId: selectedId }),
      });
      const json = (await res.json()) as { connected?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to connect');
      router.push('/settings/connections?xero=connected');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setConnecting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">

        {/* Header */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-950">
            <BookOpen className="h-6 w-6 text-blue-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Select Xero Organisation</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              You have access to multiple Xero organisations. Choose which one to connect to Kommand.
            </p>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading organisations…</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Tenant list */}
        {!loading && !error && tenants.length > 0 && (
          <div className="flex flex-col gap-2">
            {tenants.map((tenant) => {
              const selected = selectedId === tenant.id;
              return (
                <button
                  key={tenant.id}
                  type="button"
                  onClick={() => setSelectedId(tenant.id)}
                  className={`flex items-center justify-between rounded-xl border p-4 text-left transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50'
                      : 'border-border bg-muted/30 hover:bg-muted/60'
                  }`}
                >
                  <span className="font-medium">{tenant.name}</span>
                  {selected && <CheckCircle2 className="h-5 w-5 text-blue-500" />}
                </button>
              );
            })}

            <Button
              className="mt-4 w-full"
              disabled={!selectedId || connecting}
              onClick={handleConnect}
            >
              {connecting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                'Connect Organisation'
              )}
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && tenants.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No Xero organisations found. Please try reconnecting.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Page (Suspense boundary for useSearchParams) ─────────────────────────────

export default function XeroSelectTenantPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SelectTenantContent />
    </Suspense>
  );
}
