'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/',         label: 'Bridge'   },
  { href: '/trade',    label: 'Trade'    },
  { href: '/withdraw', label: 'Withdraw' },
];

export function NavTabs() {
  const pathname = usePathname() ?? '/';

  return (
    <div className="mx-auto max-w-5xl px-4 -mb-px">
      <nav className="flex items-end justify-end gap-1">
        {TABS.map((t) => {
          const active = t.href === '/'
            ? pathname === '/'
            : pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <Link
              key={t.href}
              href={t.href}
              className={
                'rounded-t-md border px-4 py-1.5 text-sm transition-colors ' +
                (active
                  ? 'border-gray-800 border-b-transparent bg-gray-950 text-bob-300 font-semibold'
                  : 'border-gray-800 bg-gray-900/60 text-gray-400 hover:text-gray-100 hover:bg-gray-900')
              }
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
