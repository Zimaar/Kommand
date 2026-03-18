import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import {
  MessageSquare,
  ShoppingCart,
  FileText,
  Bell,
  BarChart3,
  Globe,
  ArrowRight,
  Check,
  Zap,
  Link2,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect('/overview');

  return (
    <main className="min-h-screen">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/10 bg-[#0A0A12]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <span className="text-xl font-bold tracking-tight text-white">
            Kommand
          </span>
          <div className="flex items-center gap-4">
            <Link
              href="/sign-in"
              className="text-sm text-gray-400 transition hover:text-white"
            >
              Sign in
            </Link>
            <Link href="/sign-up">
              <Button size="sm" className="rounded-full px-5">
                Start free trial
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-[#0A0A12] pt-32 pb-24 md:pt-44 md:pb-32">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(83,74,183,0.15)_0%,_transparent_70%)]" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="grid items-center gap-12 md:grid-cols-2">
            <div className="max-w-xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-400">
                <Zap className="h-3 w-3 text-primary" />
                Powered by AI
              </div>
              <h1 className="mb-6 text-4xl font-bold leading-[1.1] tracking-tight text-white md:text-6xl">
                Your business,
                <br />
                <span className="text-primary">as a conversation.</span>
              </h1>
              <p className="mb-8 max-w-md text-lg text-gray-400">
                Manage sales, orders, invoices, and more — all from WhatsApp.
                One chat to run your entire store.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/sign-up">
                  <Button size="lg" className="gap-2 rounded-full px-8">
                    Start free trial <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <a href="#how-it-works">
                  <Button
                    variant="outline"
                    size="lg"
                    className="rounded-full border-white/10 bg-transparent px-8 text-gray-300 hover:bg-white/5 hover:text-white"
                  >
                    See how it works
                  </Button>
                </a>
              </div>
            </div>

            {/* Mock WhatsApp Chat */}
            <div className="flex justify-center md:justify-end">
              <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#111118] shadow-2xl shadow-primary/5">
                {/* Chat header */}
                <div className="flex items-center gap-3 rounded-t-2xl border-b border-white/10 bg-[#16161f] px-4 py-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/20 text-sm font-bold text-primary">
                    K
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Kommand</p>
                    <p className="text-xs text-green-400">Online</p>
                  </div>
                </div>
                {/* Messages */}
                <div className="flex flex-col gap-3 p-4">
                  <ChatBubble side="right" text="How's today?" />
                  <ChatBubble
                    side="left"
                    text={`Today's looking great! 🚀\n\n📦 12 orders · AED 4,280\n👥 3 new customers\n🔥 Top seller: Classic White Tee\n\nUp 18% vs yesterday.`}
                  />
                  <ChatBubble side="right" text="Refund order #1847" />
                  <ChatBubble
                    side="left"
                    text={`✅ Refund processed\n\nOrder #1847 · AED 189\nCustomer: Sarah K.\nReason: Size exchange\n\nRefund will appear in 3-5 days.`}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="border-t border-gray-100 bg-white py-24 dark:border-white/5 dark:bg-[#0A0A12]">
        <div className="mx-auto max-w-6xl px-6 text-center">
          <h2 className="mb-4 text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white">
            You check 8 apps a day
            <br />
            just to run your store.
          </h2>
          <p className="mx-auto mb-12 max-w-lg text-gray-500 dark:text-gray-400">
            Shopify, Xero, WhatsApp, email, spreadsheets, dashboards...
            switching between them costs you hours every week.
          </p>
          <div className="mx-auto max-w-3xl">
            <div className="mb-8 grid grid-cols-4 gap-3 opacity-50 sm:grid-cols-4">
              {[
                'Shopify',
                'Xero',
                'Excel',
                'Gmail',
                'Analytics',
                'Slack',
                'Notion',
                'Calendar',
              ].map((app) => (
                <div
                  key={app}
                  className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-4 text-xs font-medium text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400"
                >
                  {app}
                </div>
              ))}
            </div>
            <ChevronRight className="mx-auto mb-8 h-8 w-8 rotate-90 text-gray-300 dark:text-gray-600" />
            <div className="inline-flex items-center gap-3 rounded-2xl border-2 border-primary/30 bg-primary/5 px-8 py-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-white">
                K
              </div>
              <span className="text-lg font-semibold text-gray-900 dark:text-white">
                Just Kommand
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        className="border-t border-gray-100 bg-gray-50 py-24 dark:border-white/5 dark:bg-[#0d0d15]"
      >
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white">
              Three steps. That&apos;s it.
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              Connect your tools, chat naturally, control everything.
            </p>
          </div>
          <div className="grid gap-8 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Connect',
                description:
                  'Link your Shopify store and Xero account in two clicks. We handle the rest.',
                icon: Link2,
                example: '"Connect my Shopify store"',
              },
              {
                step: '02',
                title: 'Chat',
                description:
                  'Send a WhatsApp message, just like texting a colleague. Ask anything about your business.',
                icon: MessageSquare,
                example: '"What were my top 5 products this week?"',
              },
              {
                step: '03',
                title: 'Control',
                description:
                  'Refund orders, create invoices, update prices — all confirmed before executing.',
                icon: Zap,
                example: '"Create an invoice for Sarah, AED 500"',
              },
            ].map((item) => (
              <div
                key={item.step}
                className="group rounded-2xl border border-gray-200 bg-white p-8 transition hover:border-primary/30 hover:shadow-lg dark:border-white/5 dark:bg-[#111118] dark:hover:border-primary/20"
              >
                <div className="mb-4 flex items-center gap-3">
                  <span className="text-sm font-bold text-primary">
                    {item.step}
                  </span>
                  <item.icon className="h-5 w-5 text-gray-400 dark:text-gray-500" />
                </div>
                <h3 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
                  {item.title}
                </h3>
                <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
                  {item.description}
                </p>
                <div className="rounded-lg bg-gray-50 px-4 py-2.5 text-sm italic text-gray-500 dark:bg-white/5 dark:text-gray-400">
                  {item.example}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-gray-100 bg-white py-24 dark:border-white/5 dark:bg-[#0A0A12]">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white">
              Everything you need, nothing you don&apos;t.
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              Built for founders who want to move fast.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: BarChart3,
                title: 'Sales queries',
                description:
                  'Ask about revenue, top products, customer trends — instant answers in plain language.',
              },
              {
                icon: ShoppingCart,
                title: 'Order management',
                description:
                  'Look up, refund, cancel, or fulfill orders. All with a single message.',
              },
              {
                icon: FileText,
                title: 'Invoice control',
                description:
                  'Create, send, and track invoices through Xero without opening a single tab.',
              },
              {
                icon: Bell,
                title: 'Proactive alerts',
                description:
                  'Low stock, big orders, daily summaries — Kommand tells you before you have to ask.',
              },
              {
                icon: BarChart3,
                title: 'Smart reports',
                description:
                  'Morning briefs, weekly comparisons, profit & loss — delivered to your WhatsApp.',
              },
              {
                icon: Globe,
                title: 'Multi-platform',
                description:
                  'WhatsApp today, Slack and email tomorrow. One AI brain, any messaging channel.',
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:border-primary/30 hover:shadow-md dark:border-white/5 dark:bg-[#111118] dark:hover:border-primary/20"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <feature.icon className="h-5 w-5" />
                </div>
                <h3 className="mb-2 font-semibold text-gray-900 dark:text-white">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-gray-100 bg-gray-50 py-24 dark:border-white/5 dark:bg-[#0d0d15]">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white">
              Simple, transparent pricing.
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              Start free. Upgrade when you&apos;re ready.
            </p>
          </div>
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-3">
            {[
              {
                name: 'Starter',
                price: '0',
                period: 'forever',
                description: 'For trying things out',
                features: [
                  '100 messages / month',
                  '1 Shopify store',
                  'Basic sales queries',
                  'WhatsApp channel',
                ],
                cta: 'Get started',
                highlighted: false,
              },
              {
                name: 'Growth',
                price: '49',
                period: '/mo',
                description: 'For active store owners',
                features: [
                  'Unlimited messages',
                  '1 Shopify store',
                  'Order management',
                  'Xero integration',
                  'Proactive alerts',
                  'Smart reports',
                ],
                cta: 'Start free trial',
                highlighted: true,
              },
              {
                name: 'Pro',
                price: '149',
                period: '/mo',
                description: 'For scaling businesses',
                features: [
                  'Everything in Growth',
                  'Multiple stores',
                  'Priority support',
                  'Custom workflows',
                  'API access',
                  'Team members',
                ],
                cta: 'Start free trial',
                highlighted: false,
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-2xl border p-8 ${
                  plan.highlighted
                    ? 'border-primary bg-white shadow-xl shadow-primary/5 dark:bg-[#111118]'
                    : 'border-gray-200 bg-white dark:border-white/5 dark:bg-[#111118]'
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-4 py-1 text-xs font-medium text-white">
                    Most popular
                  </div>
                )}
                <h3 className="mb-1 text-lg font-semibold text-gray-900 dark:text-white">
                  {plan.name}
                </h3>
                <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
                  {plan.description}
                </p>
                <div className="mb-6">
                  <span className="text-4xl font-bold text-gray-900 dark:text-white">
                    ${plan.price}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {plan.period}
                  </span>
                </div>
                <Link href="/sign-up" className="block">
                  <Button
                    className="w-full rounded-full"
                    variant={plan.highlighted ? 'default' : 'outline'}
                  >
                    {plan.cta}
                  </Button>
                </Link>
                <ul className="mt-6 space-y-3">
                  {plan.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400"
                    >
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden bg-[#0A0A12] py-24">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(83,74,183,0.2)_0%,_transparent_70%)]" />
        <div className="relative mx-auto max-w-6xl px-6 text-center">
          <h2 className="mb-4 text-3xl font-bold tracking-tight text-white md:text-5xl">
            Ready to run your business
            <br />
            from WhatsApp?
          </h2>
          <p className="mx-auto mb-8 max-w-md text-lg text-gray-400">
            Join founders who manage their entire store with a single
            conversation.
          </p>
          <Link href="/sign-up">
            <Button size="lg" className="gap-2 rounded-full px-10 text-base">
              Start free trial <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 bg-[#0A0A12] py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-8 md:grid-cols-4">
            <div>
              <span className="text-lg font-bold text-white">Kommand</span>
              <p className="mt-2 text-sm text-gray-500">
                Your business, as a conversation.
              </p>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-400">
                Product
              </h4>
              <ul className="space-y-2 text-sm text-gray-500">
                <li>
                  <a href="#how-it-works" className="hover:text-white">
                    How it works
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Pricing
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Changelog
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-400">
                Company
              </h4>
              <ul className="space-y-2 text-sm text-gray-500">
                <li>
                  <a href="#" className="hover:text-white">
                    About
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Blog
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Contact
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold text-gray-400">
                Legal
              </h4>
              <ul className="space-y-2 text-sm text-gray-500">
                <li>
                  <a href="#" className="hover:text-white">
                    Privacy
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white">
                    Terms
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/5 pt-8 md:flex-row">
            <p className="text-sm text-gray-600">
              Built for founders, by founders.
            </p>
            {/* Product Hunt badge placeholder */}
            <div className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-500">
              Product Hunt badge coming soon
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ChatBubble({ side, text }: { side: 'left' | 'right'; text: string }) {
  return (
    <div className={`flex ${side === 'right' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-line rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          side === 'right'
            ? 'rounded-br-md bg-primary/20 text-primary-foreground'
            : 'rounded-bl-md bg-[#1a1a25] text-gray-300'
        }`}
      >
        {text}
      </div>
    </div>
  );
}
