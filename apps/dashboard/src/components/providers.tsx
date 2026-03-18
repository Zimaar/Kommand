'use client';

import { ThemeProvider, type ThemeProviderProps } from 'next-themes';

type Props = ThemeProviderProps & { children: React.ReactNode };
const Provider = ThemeProvider as React.ComponentType<Props>;

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Provider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </Provider>
  );
}
