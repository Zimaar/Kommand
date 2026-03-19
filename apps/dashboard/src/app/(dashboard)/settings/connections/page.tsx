'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShoppingBag,
  MessageSquare,
  BookOpen,
  Zap,
  Mail,
  RefreshCw,
  Unplug,
  Plus,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShopifyConnection {
  id: string;
  platform: string;
  shopDomain: string;
  shopName: string | null;
  isActive: boolean;
  installedAt: string;
  lastSyncedAt: string | null;
  updatedAt: string;
}

interface AccountingConnection {
  id: string;
  platform: string;
  tenantName: string | null;
  isActive: boolean;
  tokenExpiresAt: string | null;
  updatedAt: string;
}

interface Channel {
  id: string;
  type: string;
  channelId: string;
  isActive: boolean;
  updatedAt: string;
}

interface ConnectionsData {
  shopify: ShopifyConnection | null;
  accounting: AccountingConnection | null;
  channels: Channel[];
}

type DisconnectPhase = 'idle' | 'confirming' | 'loading';
type RefreshPhase    = 'idle' | 'loading';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  }).format(new Date(iso));
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hrs   = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hrs  < 24)  return `${hrs}h ago`;
  if (days < 7)   return `${days}d ago`;
  return formatDate(iso);
}

function isTokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

// ─── Status badge ─────────────────────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'expired' | 'error';

function statusFor(
  isActive: boolean,
  tokenExpiresAt?: string | null
): ConnectionStatus {
  if (!isActive) return 'disconnected';
  if (isTokenExpired(tokenExpiresAt)) return 'expired';
  return 'connected';
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { icon: React.ReactNode; label: string; className: string }> = {
    connected:    { icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: 'Connected',    className: 'text-green-700  dark:text-green-400  bg-green-50  dark:bg-green-950  border-green-200  dark:border-green-800' },
    disconnected: { icon: <XCircle      className="h-3.5 w-3.5" />, label: 'Disconnected', className: 'text-muted-foreground bg-muted border-border' },
    expired:      { icon: <AlertCircle  className="h-3.5 w-3.5" />, label: 'Expired',      className: 'text-amber-700   dark:text-amber-400   bg-amber-50  dark:bg-amber-950  border-amber-200  dark:border-amber-800' },
    error:        { icon: <AlertCircle  className="h-3.5 w-3.5" />, label: 'Error',        className: 'text-destructive bg-destructive/10 border-destructive/30' },
  };
  const { icon, label, className } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}>
      {icon}{label}
    </span>
  );
}

// ─── Platform meta ────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  shopify:    { label: 'Shopify',    icon: <ShoppingBag className="h-5 w-5" />, color: 'text-green-600' },
  xero:       { label: 'Xero',       icon: <BookOpen    className="h-5 w-5" />, color: 'text-blue-500'  },
  quickbooks: { label: 'QuickBooks', icon: <BookOpen    className="h-5 w-5" />, color: 'text-green-500' },
  freshbooks: { label: 'FreshBooks', icon: <BookOpen    className="h-5 w-5" />, color: 'text-indigo-500'},
  whatsapp:   { label: 'WhatsApp',   icon: <MessageSquare className="h-5 w-5" />, color: 'text-green-500' },
  slack:      { label: 'Slack',      icon: <Zap         className="h-5 w-5" />, color: 'text-purple-500'},
  email:      { label: 'Email',      icon: <Mail        className="h-5 w-5" />, color: 'text-blue-400'  },
  telegram:   { label: 'Telegram',   icon: <MessageSquare className="h-5 w-5" />, color: 'text-sky-500' },
};

function platformMeta(key: string) {
  return PLATFORM_META[key] ?? {
    label: key.charAt(0).toUpperCase() + key.slice(1),
    icon:  <Zap className="h-5 w-5" />,
    color: 'text-muted-foreground',
  };
}

// ─── Connection card ──────────────────────────────────────────────────────────

interface ConnectionCardProps {
  id: string;
  platform: string;
  title: string;           // store name / phone / tenant name
  subtitle: string;        // domain / raw identifier
  connectedAt: string;
  lastActivity: string | null;
  status: ConnectionStatus;
  onDisconnect: (id: string) => Promise<void>;
  onRefresh: (id: string) => Promise<void>;
  onReconnect: (platform: string) => void;
}

function ConnectionCard({
  id, platform, title, subtitle, connectedAt, lastActivity,
  status, onDisconnect, onRefresh, onReconnect,
}: ConnectionCardProps) {
  const [disconnectPhase, setDisconnectPhase] = useState<DisconnectPhase>('idle');
  const [refreshPhase,    setRefreshPhase]    = useState<RefreshPhase>('idle');
  const [cardError,       setCardError]       = useState('');

  const meta = platformMeta(platform);

  async function handleDisconnect() {
    if (disconnectPhase === 'idle') { setDisconnectPhase('confirming'); return; }
    setDisconnectPhase('loading');
    setCardError('');
    try {
      await onDisconnect(id);
    } catch (err) {
      setCardError(err instanceof Error ? err.message : 'Failed to disconnect');
      setDisconnectPhase('idle');
    }
  }

  async function handleRefresh() {
    setRefreshPhase('loading');
    setCardError('');
    try {
      await onRefresh(id);
    } catch (err) {
      setCardError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setRefreshPhase('idle');
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">

        {/* Left: icon + details */}
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 shrink-0 ${meta.color}`}>{meta.icon}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{meta.label}</span>
              <StatusBadge status={status} />
            </div>
            <p className="mt-0.5 text-sm font-medium text-foreground">{title}</p>
            {subtitle !== title && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Connected {formatDate(connectedAt)}
              </span>
              {lastActivity && (
                <span>Last synced {formatRelative(lastActivity)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          {status === 'connected' ? (
            <>
              {/* Evaluate all three disconnect phases explicitly to avoid TS narrowing issues */}
              {disconnectPhase === 'loading' ? (
                <Button variant="destructive" size="sm" disabled>
                  <Loader2 className="h-3 w-3 animate-spin" />
                </Button>
              ) : disconnectPhase === 'confirming' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Are you sure?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDisconnect}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDisconnectPhase('idle')}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  className="gap-1.5"
                >
                  <Unplug className="h-3.5 w-3.5" />
                  Disconnect
                </Button>
              )}
            </>
          ) : (
            <div className="flex flex-col items-end gap-2">
              <Button
                size="sm"
                onClick={() => onReconnect(platform)}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshPhase === 'loading'}
                className="gap-1.5 text-xs"
              >
                {refreshPhase === 'loading'
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
                Try refresh
              </Button>
            </div>
          )}
        </div>
      </div>

      {cardError && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {cardError}
        </p>
      )}
    </div>
  );
}

// ─── Available platform tile ──────────────────────────────────────────────────

function AvailablePlatformTile({
  platform,
  comingSoon,
  onConnect,
}: {
  platform: string;
  comingSoon?: boolean;
  onConnect: (platform: string) => void;
}) {
  const meta = platformMeta(platform);
  return (
    <button
      type="button"
      onClick={() => !comingSoon && onConnect(platform)}
      disabled={comingSoon}
      className="flex flex-col items-center gap-2 rounded-xl border bg-card p-5 text-center shadow-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className={`${meta.color}`}>{meta.icon}</div>
      <span className="text-sm font-medium">{meta.label}</span>
      {comingSoon && (
        <span className="text-xs text-muted-foreground">Coming soon</span>
      )}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ConnectionsSettingsPage() {
  const router = useRouter();

  const [data,    setData]    = useState<ConnectionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/connections');
      if (!res.ok) throw new Error('Failed to fetch connections');
      const json = (await res.json()) as ConnectionsData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleDisconnect(id: string): Promise<void> {
    const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? 'Failed to disconnect');
    await fetchConnections();
  }

  async function handleRefresh(id: string): Promise<void> {
    const res = await fetch(`/api/connections/${id}/refresh`, { method: 'POST' });
    const json = (await res.json()) as {
      error?: string;
      refreshed?: boolean;
      requiresReconnect?: boolean;
    };
    if (!res.ok) throw new Error(json.error ?? 'Failed to refresh');
    if (json.requiresReconnect) {
      throw new Error('Token expired — please reconnect via the Reconnect button');
    }
    await fetchConnections();
  }

  function handleReconnect(platform: string) {
    switch (platform) {
      case 'shopify':
        router.push('/onboarding?step=1');
        break;
      case 'whatsapp':
        router.push('/onboarding/whatsapp');
        break;
      case 'xero':
      case 'quickbooks':
      case 'freshbooks':
        // M5 accounting OAuth — placeholder for now
        router.push('/onboarding/preferences');
        break;
      default:
        router.push('/onboarding');
    }
  }

  function handleAddPlatform(platform: string) {
    handleReconnect(platform);
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const waChannel  = data?.channels.find((c) => c.type === 'whatsapp');
  const hasShopify = !!data?.shopify;
  const hasXero    = !!data?.accounting;
  const hasWA      = !!waChannel;

  // Platforms with active connections are hidden from the "add" section
  const addablePlatforms = [
    !hasShopify && { platform: 'shopify', comingSoon: false },
    !hasXero    && { platform: 'xero',    comingSoon: true  },
    !hasWA      && { platform: 'whatsapp',comingSoon: false },
    { platform: 'slack',    comingSoon: true },
    { platform: 'email',    comingSoon: true },
  ].filter(Boolean) as { platform: string; comingSoon: boolean }[];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Connections</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your connected platforms and messaging channels.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading connections…</span>
        </div>
      )}

      {/* Global error */}
      {!loading && error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
          <Button variant="ghost" size="sm" onClick={fetchConnections} className="ml-auto">
            Retry
          </Button>
        </div>
      )}

      {/* Active connections */}
      {!loading && data && (
        <>
          {/* Shopify */}
          {data.shopify && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                E-Commerce
              </h2>
              <ConnectionCard
                id={data.shopify.id}
                platform="shopify"
                title={data.shopify.shopName ?? data.shopify.shopDomain}
                subtitle={data.shopify.shopDomain}
                connectedAt={data.shopify.installedAt}
                lastActivity={data.shopify.lastSyncedAt ?? data.shopify.updatedAt}
                status={statusFor(data.shopify.isActive)}
                onDisconnect={handleDisconnect}
                onRefresh={handleRefresh}
                onReconnect={handleReconnect}
              />
            </section>
          )}

          {/* Accounting */}
          {data.accounting && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Accounting
              </h2>
              <ConnectionCard
                id={data.accounting.id}
                platform={data.accounting.platform}
                title={data.accounting.tenantName ?? data.accounting.platform}
                subtitle={data.accounting.platform}
                connectedAt={data.accounting.updatedAt}
                lastActivity={data.accounting.updatedAt}
                status={statusFor(data.accounting.isActive, data.accounting.tokenExpiresAt)}
                onDisconnect={handleDisconnect}
                onRefresh={handleRefresh}
                onReconnect={handleReconnect}
              />
            </section>
          )}

          {/* Channels */}
          {data.channels.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Messaging Channels
              </h2>
              {data.channels.map((ch) => (
                <ConnectionCard
                  key={ch.id}
                  id={ch.id}
                  platform={ch.type}
                  title={ch.channelId}
                  subtitle={ch.channelId}
                  connectedAt={ch.updatedAt}
                  lastActivity={ch.updatedAt}
                  status={statusFor(ch.isActive)}
                  onDisconnect={handleDisconnect}
                  onRefresh={handleRefresh}
                  onReconnect={handleReconnect}
                />
              ))}
            </section>
          )}

          {/* Empty state */}
          {!data.shopify && !data.accounting && data.channels.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
              <Unplug className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">No connections yet</p>
              <p className="text-sm text-muted-foreground">
                Connect a platform below to start using Kommand.
              </p>
            </div>
          )}

          {/* Add Connection */}
          {addablePlatforms.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Plus className="h-4 w-4" />
                Add Connection
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {addablePlatforms.map(({ platform, comingSoon }) => (
                  <AvailablePlatformTile
                    key={platform}
                    platform={platform}
                    comingSoon={comingSoon}
                    onConnect={handleAddPlatform}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
