'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, ChevronLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = ['Connect Shopify', 'Connect WhatsApp', 'Preferences'];
const CURRENT_STEP = 3; // 1-indexed, all segments filled

/** IANA timezone list — common zones grouped by UTC offset, sorted. */
const TIMEZONES = [
  // UTC−12 → UTC−5 (Americas)
  { value: 'Pacific/Honolulu',          label: 'UTC−10  Hawaii' },
  { value: 'America/Anchorage',         label: 'UTC−9   Alaska' },
  { value: 'America/Los_Angeles',       label: 'UTC−8   Pacific Time (US)' },
  { value: 'America/Denver',            label: 'UTC−7   Mountain Time (US)' },
  { value: 'America/Phoenix',           label: 'UTC−7   Arizona' },
  { value: 'America/Chicago',           label: 'UTC−6   Central Time (US)' },
  { value: 'America/Mexico_City',       label: 'UTC−6   Mexico City' },
  { value: 'America/New_York',          label: 'UTC−5   Eastern Time (US)' },
  { value: 'America/Toronto',           label: 'UTC−5   Toronto' },
  { value: 'America/Bogota',            label: 'UTC−5   Bogotá' },
  { value: 'America/Sao_Paulo',         label: 'UTC−3   São Paulo' },
  { value: 'America/Argentina/Buenos_Aires', label: 'UTC−3   Buenos Aires' },
  { value: 'Atlantic/South_Georgia',    label: 'UTC−2   South Georgia' },
  // UTC−1 → UTC+0
  { value: 'Atlantic/Azores',           label: 'UTC−1   Azores' },
  { value: 'Europe/London',             label: 'UTC±0   London' },
  { value: 'Africa/Abidjan',            label: 'UTC±0   Abidjan' },
  // UTC+1 → UTC+3 (Europe / Africa)
  { value: 'Europe/Paris',              label: 'UTC+1   Paris / Berlin' },
  { value: 'Europe/Amsterdam',          label: 'UTC+1   Amsterdam' },
  { value: 'Africa/Lagos',              label: 'UTC+1   Lagos' },
  { value: 'Africa/Cairo',              label: 'UTC+2   Cairo' },
  { value: 'Africa/Johannesburg',       label: 'UTC+2   Johannesburg' },
  { value: 'Europe/Helsinki',           label: 'UTC+2   Helsinki' },
  { value: 'Europe/Istanbul',           label: 'UTC+3   Istanbul' },
  { value: 'Asia/Riyadh',               label: 'UTC+3   Riyadh' },
  { value: 'Africa/Nairobi',            label: 'UTC+3   Nairobi' },
  { value: 'Europe/Moscow',             label: 'UTC+3   Moscow' },
  // UTC+4 → UTC+6
  { value: 'Asia/Dubai',                label: 'UTC+4   Dubai' },
  { value: 'Asia/Karachi',              label: 'UTC+5   Karachi' },
  { value: 'Asia/Kolkata',              label: 'UTC+5:30 Mumbai / Delhi' },
  { value: 'Asia/Dhaka',                label: 'UTC+6   Dhaka' },
  // UTC+7 → UTC+9
  { value: 'Asia/Bangkok',              label: 'UTC+7   Bangkok / Jakarta' },
  { value: 'Asia/Shanghai',             label: 'UTC+8   Shanghai / Beijing' },
  { value: 'Asia/Singapore',            label: 'UTC+8   Singapore' },
  { value: 'Asia/Kuala_Lumpur',         label: 'UTC+8   Kuala Lumpur' },
  { value: 'Australia/Perth',           label: 'UTC+8   Perth' },
  { value: 'Asia/Tokyo',                label: 'UTC+9   Tokyo / Seoul' },
  // UTC+10 → UTC+12
  { value: 'Australia/Sydney',          label: 'UTC+10  Sydney' },
  { value: 'Australia/Melbourne',       label: 'UTC+10  Melbourne' },
  { value: 'Pacific/Auckland',          label: 'UTC+12  Auckland' },
] as const;

/** ISO 4217 currencies — most common for e-commerce. */
const CURRENCIES = [
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'EUR', label: 'EUR — Euro (€)' },
  { value: 'GBP', label: 'GBP — British Pound (£)' },
  { value: 'CAD', label: 'CAD — Canadian Dollar (CA$)' },
  { value: 'AUD', label: 'AUD — Australian Dollar (A$)' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar (NZ$)' },
  { value: 'INR', label: 'INR — Indian Rupee (₹)' },
  { value: 'BRL', label: 'BRL — Brazilian Real (R$)' },
  { value: 'MXN', label: 'MXN — Mexican Peso ($)' },
  { value: 'ZAR', label: 'ZAR — South African Rand (R)' },
  { value: 'NGN', label: 'NGN — Nigerian Naira (₦)' },
  { value: 'KES', label: 'KES — Kenyan Shilling (KSh)' },
  { value: 'AED', label: 'AED — UAE Dirham (د.إ)' },
  { value: 'SAR', label: 'SAR — Saudi Riyal (﷼)' },
  { value: 'SGD', label: 'SGD — Singapore Dollar (S$)' },
  { value: 'MYR', label: 'MYR — Malaysian Ringgit (RM)' },
  { value: 'IDR', label: 'IDR — Indonesian Rupiah (Rp)' },
  { value: 'PHP', label: 'PHP — Philippine Peso (₱)' },
  { value: 'PKR', label: 'PKR — Pakistani Rupee (₨)' },
  { value: 'BDT', label: 'BDT — Bangladeshi Taka (৳)' },
  { value: 'EGP', label: 'EGP — Egyptian Pound (£)' },
  { value: 'JPY', label: 'JPY — Japanese Yen (¥)' },
  { value: 'CNY', label: 'CNY — Chinese Yuan (¥)' },
  { value: 'KRW', label: 'KRW — South Korean Won (₩)' },
  { value: 'RUB', label: 'RUB — Russian Ruble (₽)' },
] as const;

/** Map locale prefix → IANA timezone + currency. */
const LOCALE_DEFAULTS: Record<string, { tz: string; currency: string }> = {
  'en-US':  { tz: 'America/New_York',    currency: 'USD' },
  'en-CA':  { tz: 'America/Toronto',     currency: 'CAD' },
  'en-GB':  { tz: 'Europe/London',       currency: 'GBP' },
  'en-AU':  { tz: 'Australia/Sydney',    currency: 'AUD' },
  'en-NZ':  { tz: 'Pacific/Auckland',    currency: 'NZD' },
  'en-IN':  { tz: 'Asia/Kolkata',        currency: 'INR' },
  'en-ZA':  { tz: 'Africa/Johannesburg', currency: 'ZAR' },
  'en-NG':  { tz: 'Africa/Lagos',        currency: 'NGN' },
  'en-KE':  { tz: 'Africa/Nairobi',      currency: 'KES' },
  'en-SG':  { tz: 'Asia/Singapore',      currency: 'SGD' },
  'en-MY':  { tz: 'Asia/Kuala_Lumpur',   currency: 'MYR' },
  'pt-BR':  { tz: 'America/Sao_Paulo',   currency: 'BRL' },
  'es-MX':  { tz: 'America/Mexico_City', currency: 'MXN' },
  'ar-AE':  { tz: 'Asia/Dubai',          currency: 'AED' },
  'ar-SA':  { tz: 'Asia/Riyadh',         currency: 'SAR' },
  'de':     { tz: 'Europe/Paris',        currency: 'EUR' },
  'fr':     { tz: 'Europe/Paris',        currency: 'EUR' },
  'it':     { tz: 'Europe/Paris',        currency: 'EUR' },
  'es':     { tz: 'Europe/Paris',        currency: 'EUR' },
  'ru':     { tz: 'Europe/Moscow',       currency: 'RUB' },
  'ja':     { tz: 'Asia/Tokyo',          currency: 'JPY' },
  'zh':     { tz: 'Asia/Shanghai',       currency: 'CNY' },
  'ko':     { tz: 'Asia/Tokyo',          currency: 'KRW' },
  'hi':     { tz: 'Asia/Kolkata',        currency: 'INR' },
};

const DEFAULT_TZ       = 'America/New_York';
const DEFAULT_CURRENCY = 'USD';

// ─── Confetti (pure canvas — no external package) ─────────────────────────────

function launchConfetti(): void {
  if (typeof document === 'undefined') return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  document.body.appendChild(canvas);

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  const palette = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#f43f5e'];

  const particles: {
    x: number; y: number;
    vx: number; vy: number;
    color: string; w: number; h: number;
    angle: number; vAngle: number;
    alpha: number;
  }[] = [];

  for (let i = 0; i < 160; i++) {
    particles.push({
      x:      Math.random() * canvas.width,
      y:      -Math.random() * canvas.height * 0.5,
      vx:     (Math.random() - 0.5) * 7,
      vy:     Math.random() * 4 + 3,
      color:  palette[Math.floor(Math.random() * palette.length)]!,
      w:      Math.random() * 10 + 5,
      h:      Math.random() * 5  + 3,
      angle:  Math.random() * Math.PI * 2,
      vAngle: (Math.random() - 0.5) * 0.25,
      alpha:  1,
    });
  }

  let frame = 0;
  const TOTAL_FRAMES = 210;

  function animate() {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x      += p.vx;
      p.y      += p.vy;
      p.vy     += 0.08; // gravity
      p.angle  += p.vAngle;
      p.alpha   = Math.max(0, 1 - frame / TOTAL_FRAMES);

      ctx!.save();
      ctx!.globalAlpha = p.alpha;
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.angle);
      ctx!.fillStyle = p.color;
      ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx!.restore();
    }

    frame++;
    if (frame < TOTAL_FRAMES) {
      requestAnimationFrame(animate);
    } else {
      canvas.remove();
    }
  }

  animate();
}

// ─── Toggle switch component ──────────────────────────────────────────────────

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

function Toggle({ id, checked, onChange, label, description }: ToggleProps) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/40"
    >
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      {/* Accessible toggle — hidden checkbox + visual pill */}
      <div className="relative shrink-0">
        <input
          id={id}
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div
          className={`h-6 w-11 rounded-full transition-colors ${
            checked ? 'bg-primary' : 'bg-input'
          }`}
        />
        <div
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </div>
    </label>
  );
}

// ─── Page (Suspense wrapper) ──────────────────────────────────────────────────

export default function PreferencesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PreferencesContent />
    </Suspense>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

interface NotificationState {
  newOrders:       boolean;
  lowInventory:    boolean;
  paymentFailures: boolean;
  dailySummary:    boolean;
}

function PreferencesContent() {
  const router = useRouter();

  // Preferences state
  const [timezone,         setTimezone]         = useState(DEFAULT_TZ);
  const [morningBriefTime, setMorningBriefTime] = useState('08:00');
  const [currency,         setCurrency]         = useState(DEFAULT_CURRENCY);
  const [notifications, setNotifications] = useState<NotificationState>({
    newOrders:       true,
    lowInventory:    true,
    paymentFailures: true,
    dailySummary:    true,
  });

  // UI state
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  // ─── Auto-detect timezone + currency from browser locale ────────────────

  useEffect(() => {
    if (typeof navigator === 'undefined') return;

    // 1. Prefer Intl API for exact timezone
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const match = TIMEZONES.find((t) => t.value === detected);
    if (match) setTimezone(match.value);

    // 2. Locale → currency (and timezone fallback if Intl didn't match a known zone)
    const lang = navigator.language ?? '';
    for (const [prefix, defaults] of Object.entries(LOCALE_DEFAULTS)) {
      if (lang.toLowerCase().startsWith(prefix.toLowerCase())) {
        if (!match) setTimezone(defaults.tz);
        setCurrency(defaults.currency);
        break;
      }
    }
  }, []);

  // ─── Submit ─────────────────────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    setSaving(true);
    setError('');

    const payload = {
      timezone,
      morningBriefTime,
      currency,
      notifications,
    };

    try {
      // 1. Persist user preferences
      const prefRes = await fetch('/api/users/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!prefRes.ok) {
        const data = (await prefRes.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to save preferences');
      }

      // 2. Create default scheduled jobs
      const jobRes = await fetch('/api/jobs/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!jobRes.ok) {
        const data = (await jobRes.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to create scheduled jobs');
      }

      // 🎉 All done — fire confetti then navigate
      launchConfetti();

      // Brief pause so the confetti is visible before nav
      await new Promise((resolve) => setTimeout(resolve, 1800));
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setSaving(false);
    }
  }, [timezone, morningBriefTime, currency, notifications, router]);

  function toggleNotification(key: keyof NotificationState) {
    setNotifications((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">

        {/* ── Progress bar (all 3 segments filled) ─────────────────────── */}
        <div className="mb-8 flex gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${i < CURRENT_STEP ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Settings className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold">Preferences</h1>
          </div>
          <p className="text-muted-foreground">
            Almost there! Tell Kommand how and when to keep you informed.
          </p>
        </div>

        <div className="space-y-6">

          {/* ── Timezone ─────────────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label htmlFor="timezone">Your Timezone</Label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={saving}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>

          {/* ── Morning brief time ────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label htmlFor="brief-time">Morning Brief Time</Label>
            <p className="text-xs text-muted-foreground">
              Kommand sends you a daily summary at this time in your timezone.
            </p>
            <input
              id="brief-time"
              type="time"
              value={morningBriefTime}
              onChange={(e) => setMorningBriefTime(e.target.value)}
              disabled={saving}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
          </div>

          {/* ── Notification preferences ──────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Notification Preferences</Label>
            <div className="space-y-2">
              <Toggle
                id="notif-orders"
                checked={notifications.newOrders}
                onChange={() => toggleNotification('newOrders')}
                label="New orders"
                description="Get notified when a new order is placed"
              />
              <Toggle
                id="notif-inventory"
                checked={notifications.lowInventory}
                onChange={() => toggleNotification('lowInventory')}
                label="Low inventory alerts"
                description="Warn when a product falls below stock threshold"
              />
              <Toggle
                id="notif-payments"
                checked={notifications.paymentFailures}
                onChange={() => toggleNotification('paymentFailures')}
                label="Payment failures"
                description="Alert when a payment or charge fails"
              />
              <Toggle
                id="notif-summary"
                checked={notifications.dailySummary}
                onChange={() => toggleNotification('dailySummary')}
                label="Daily summary"
                description="End-of-day recap with revenue and key metrics"
              />
            </div>
          </div>

          {/* ── Currency ─────────────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label htmlFor="currency">Currency Display</Label>
            <p className="text-xs text-muted-foreground">
              Used for revenue figures in Kommand messages.
            </p>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={saving}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {CURRENCIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* ── Error ────────────────────────────────────────────────────── */}
          {error && (
            <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {/* ── CTA ──────────────────────────────────────────────────────── */}
          <Button
            className="w-full"
            size="lg"
            onClick={handleComplete}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Setting up your workspace…
              </>
            ) : (
              'Complete Setup 🎉'
            )}
          </Button>

          {/* ── Back ─────────────────────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => router.push('/onboarding/whatsapp')}
            disabled={saving}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>

        </div>
      </div>
    </div>
  );
}
