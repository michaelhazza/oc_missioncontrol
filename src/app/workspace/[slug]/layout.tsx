'use client';

import { useParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { ListTodo, Film, CalendarDays, Brain, Users, Building2 } from 'lucide-react';
import type { ReactNode } from 'react';

const NAV_ITEMS = [
  { label: 'Tasks', icon: ListTodo, path: '' },
  { label: 'Content', icon: Film, path: '/content' },
  { label: 'Calendar', icon: CalendarDays, path: '/calendar' },
  { label: 'Memory', icon: Brain, path: '/memory' },
  { label: 'Team', icon: Users, path: '/team' },
  { label: 'Office', icon: Building2, path: '/office' },
];

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const slug = params?.slug as string;

  return (
    <div className="flex flex-col h-screen bg-mc-bg">
      {/* Sub-nav bar */}
      <nav className="bg-mc-bg-secondary border-b border-mc-border px-4 flex items-center gap-1 overflow-x-auto shrink-0" style={{ minHeight: '40px' }}>
        {NAV_ITEMS.map((item) => {
          const href = `/workspace/${slug}${item.path}`;
          const isActive = item.path === ''
            ? pathname === `/workspace/${slug}`
            : pathname === href || pathname.startsWith(href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              href={href}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors whitespace-nowrap border-b-2 ${
                isActive
                  ? 'text-mc-accent border-mc-accent'
                  : 'text-mc-text-secondary border-transparent hover:text-mc-text hover:border-mc-border'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
