'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Check, ArrowRight, ChevronLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = ['Connect Shopify', 'Connect WhatsApp', 'Preferences'];
const CURRENT_STEP = 2; // 1-indexed

/** Most common WhatsApp markets — sorted by global usage. */
const COUNTRY_CODES = [
  { code: '+1',   label: '🇺🇸 +1  (US / Canada)' },
  { code: '+91',  label: '🇮🇳 +91  (India)' },
  { code: '+55',  label: '🇧🇷 +55  (Brazil)' },
  { code: '+62',  label: '🇮🇩 +62  (Indonesia)' },
  { code: '+7',   label: '🇷🇺 +7   (Russia)' },
  { code: '+52',  label: '🇲🇽 +52  (Mexico)' },
  { code: '+234', label: '🇳🇬 +234 (Nigeria)' },
  { code: '+27',  label: '🇿🇦 +27  (South Africa)' },
  { code: '+44',  label: '🇬🇧 +44  (UK)' },
  { code: '+49',  label: '🇩🇪 +49  (Germany)' },
  { code: '+33',  label: '🇫🇷 +33  (France)' },
  { code: '+34',  label: '🇪🇸 +34  (Spain)' },
  { code: '+39',  label: '🇮🇹 +39  (Italy)' },
  { code: '+971', label: '🇦🇪 +971 (UAE)' },
  { code: '+966', label: '🇸🇦 +966 (Saudi Arabia)' },
  { code: '+254', label: '🇰🇪 +254 (Kenya)' },
  { code: '+233', label: '🇬🇭 +233 (Ghana)' },
  { code: '+60',  label: '🇲🇾 +60  (Malaysia)' },
  { code: '+65',  label: '🇸🇬 +65  (Singapore)' },
  { code: '+61',  label: '🇦🇺 +61  (Australia)' },
  { code: '+92',  label: '🇵🇰 +92  (Pakistan)' },
  { code: '+880', label: '🇧🇩 +880 (Bangladesh)' },
  { code: '+20',  label: '🇪🇬 +20  (Egypt)' },
] as const;

/** Map browser locale prefix → default country dialing code. */
const LOCALE_TO_CODE: Record<string, string> = {
  'en-GB': '+44',
  'en-AU': '+61',
  'en-IN': '+91',
  'pt-BR': '+55',
  'hi':    '+91',
  'de':    '+49',
  'fr':    '+33',
  'es':    '+34',
  'it':    '+39',
  'ru':    '+7',
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'loading' | 'phone' | 'sending' | 'otp' | 'verifying' | 'verified';

interface Channel {
  id: string;
  type: string;
  channelId: string;
  isActive: boolean;
}

interface ConnectionsResponse {
  channels: Channel[];
}

// ─── Page (Suspense wrapper) ──────────────────────────────────────────────────

export default function WhatsAppOnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <WhatsAppOnboardingContent />
    </Suspense>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

function WhatsAppOnboardingContent() {
  const router = useRouter();

  // UI state
  const [phase, setPhase] = useState<Phase>('loading');
  const [countryCode, setCountryCode] = useState('+1');
  const [localNumber, setLocalNumber] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [error, setError] = useState('');
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);

  /** The full E.164 number assembled from the two inputs. */
  const fullPhone = `${countryCode}${localNumber.replace(/\D/g, '')}`;

  // ─── On mount: detect locale & check existing connection ─────────────────

  useEffect(() => {
    // Detect best default country code from browser locale
    if (typeof navigator !== 'undefined') {
      const lang = navigator.language ?? '';
      for (const [prefix, code] of Object.entries(LOCALE_TO_CODE)) {
        if (lang.toLowerCase().startsWith(prefix.toLowerCase())) {
          setCountryCode(code);
          break;
        }
      }
    }
  }, []);

  const checkExistingConnection = useCallback(async () => {
    try {
      const res = await fetch('/api/connections');
      if (res.ok) {
        const data = (await res.json()) as ConnectionsResponse;
        const waChannel = data.channels.find((c) => c.type === 'whatsapp' && c.isActive);
        if (waChannel) {
          setConnectedPhone(waChannel.channelId);
          setPhase('verified');
          return;
        }
      }
    } catch {
      // Non-fatal — show the phone input form
    }
    setPhase('phone');
  }, []);

  useEffect(() => {
    checkExistingConnection();
  }, [checkExistingConnection]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  async function handleSendCode() {
    const digits = localNumber.replace(/\D/g, '');
    if (!digits || digits.length < 6) {
      setError('Please enter a valid phone number');
      return;
    }

    setError('');
    setPhase('sending');

    try {
      const res = await fetch('/api/channels/whatsapp/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: fullPhone }),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? 'Failed to send verification code. Please try again.');
        setPhase('phone');
        return;
      }

      setPhase('otp');
    } catch {
      setError('Network error — please check your connection and try again.');
      setPhase('phone');
    }
  }

  async function handleVerify(codeOverride?: string) {
    const code = codeOverride ?? otpValue;

    if (!/^\d{6}$/.test(code)) {
      setError('Please enter all 6 digits of the verification code');
      return;
    }

    setError('');
    setPhase('verifying');

    try {
      const res = await fetch('/api/channels/whatsapp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: fullPhone, code }),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? 'Invalid code. Please check and try again.');
        setPhase('otp');
        return;
      }

      setConnectedPhone(fullPhone);
      setPhase('verified');
    } catch {
      setError('Network error — please check your connection and try again.');
      setPhase('otp');
    }
  }

  function handleOtpChange(raw: string) {
    const val = raw.replace(/\D/g, '').slice(0, 6);
    setOtpValue(val);
    setError('');
    // Auto-submit once all 6 digits are entered
    if (val.length === 6) {
      void handleVerify(val);
    }
  }

  function goBack() {
    if (phase === 'otp' || phase === 'verifying') {
      // Back within the flow → return to phone input
      setPhase('phone');
      setOtpValue('');
      setError('');
    } else {
      router.push('/onboarding?step=1');
    }
  }

  function goNext() {
    router.push('/onboarding/preferences');
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  // Full-screen spinner during initial connection check
  if (phase === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /** Subtitle copy changes with phase. */
  const subtitle =
    phase === 'otp' || phase === 'verifying'
      ? "We've sent a verification code to your WhatsApp. Enter it below:"
      : phase === 'verified'
        ? 'Your WhatsApp number is connected and ready.'
        : 'Enter your WhatsApp number to receive updates and control your store via chat.';

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-md">

        {/* ── Progress bar ─────────────────────────────────────────────── */}
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
            <MessageSquare className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold">Connect WhatsApp</h1>
          </div>
          <p className="text-muted-foreground">{subtitle}</p>
        </div>

        {/* ── Phase: phone entry ────────────────────────────────────────── */}
        {(phase === 'phone' || phase === 'sending') && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="phone-number">WhatsApp Phone Number</Label>
              <div className="mt-1 flex gap-2">
                {/* Country code selector */}
                <select
                  aria-label="Country code"
                  value={countryCode}
                  onChange={(e) => {
                    setCountryCode(e.target.value);
                    setError('');
                  }}
                  disabled={phase === 'sending'}
                  className="flex h-9 shrink-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>

                {/* Local number input */}
                <Input
                  id="phone-number"
                  type="tel"
                  inputMode="tel"
                  placeholder="6505551234"
                  value={localNumber}
                  onChange={(e) => {
                    setLocalNumber(e.target.value);
                    setError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSendCode();
                  }}
                  disabled={phase === 'sending'}
                  className="flex-1"
                />
              </div>
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            </div>

            <Button className="w-full" onClick={handleSendCode} disabled={phase === 'sending'}>
              {phase === 'sending' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending code…
                </>
              ) : (
                <>
                  Verify via WhatsApp
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={goBack}
                disabled={phase === 'sending'}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={phase === 'sending'}
                className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── Phase: OTP entry ──────────────────────────────────────────── */}
        {(phase === 'otp' || phase === 'verifying') && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="otp-input">Verification Code</Label>
              <Input
                id="otp-input"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="••••••"
                value={otpValue}
                onChange={(e) => handleOtpChange(e.target.value)}
                disabled={phase === 'verifying'}
                autoFocus
                className="mt-1 text-center text-2xl tracking-[0.6em] font-mono"
              />
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                Sent to {fullPhone}
              </p>
            </div>

            <Button
              className="w-full"
              onClick={() => void handleVerify()}
              disabled={phase === 'verifying' || otpValue.length !== 6}
            >
              {phase === 'verifying' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                'Verify Code'
              )}
            </Button>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={goBack}
                disabled={phase === 'verifying'}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Change number
              </button>
              <button
                type="button"
                onClick={handleSendCode}
                disabled={phase === 'verifying'}
                className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Resend code
              </button>
            </div>
          </div>
        )}

        {/* ── Phase: verified ───────────────────────────────────────────── */}
        {phase === 'verified' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-200 bg-green-50 p-6 dark:border-green-900 dark:bg-green-950">
              <div className="mb-4 flex items-start gap-3">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-600 dark:bg-green-500">
                  <Check className="h-3 w-3 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-green-900 dark:text-green-200">Connected</h3>
                  <p className="mt-0.5 text-sm text-green-700 dark:text-green-300">
                    {connectedPhone}
                  </p>
                </div>
              </div>

              <Button className="w-full" onClick={goNext}>
                Continue <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>

            <button
              type="button"
              onClick={() => router.push('/onboarding?step=1')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
