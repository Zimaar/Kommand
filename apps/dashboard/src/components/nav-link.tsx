'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Plug, Settings, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

const iconMap = {
  LayoutDashboard,
  Plug,
  Settings,
  MessageSquare,
} as const;

export type NavIconName = keyof typeof iconMap;

export function NavLink({ href, label, icon }: { href: string; label: string; icon: NavIconName }) {
  const pathname = usePathname();
  const Icon = iconMap[icon];

  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        pathname === href || pathname.startsWith(href + '/')
          ? 'bg-primary text-primary-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Link>
  );
}
