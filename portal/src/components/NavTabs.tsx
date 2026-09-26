'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/',         label: 'Bridge'   },
  { href: '/trade',    label: 'Trade'    },
  { href: '/withdraw', label: 'Withdraw' },
  { href: '/reserves', label: 'Reserves' },
];

export function NavTabs() {
  const pathname = usePathname() ?? '/';

  return (
    <div className="mx-auto max-w-5xl px-4 -mb-px">
      <nav className="flex items-end justify-end gap-1">
        {TABS
          // /trade stays reachable by its address, but only shows as a tab while
          // you are on it: the bridge is not a trade venue (btcbob, 2026-09-26).
          .filter((t) => t.href !== '/trade' || pathname === '/trade' || pathname.startsWith('/trade/'))
          .map((t) => {
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
                  ? 'border-[#8b6f3e] border-b-transparent bg-[#e8cf9d] text-[#3a2a14] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]'
                  : 'border-[#8b6f3e] bg-[#c9a86a] text-[#4a3618] hover:bg-[#d4b67a]')
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
