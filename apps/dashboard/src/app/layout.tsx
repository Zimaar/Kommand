import type { Metadata } from 'next';
import '@/styles/globals.css';
import { Geist } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Kommand',
  description: 'Your business, as a conversation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={cn('font-sans', geist.variable)} suppressHydrationWarning>
        <body>
          <Providers>
            {children}
            <Toaster />
          </Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
