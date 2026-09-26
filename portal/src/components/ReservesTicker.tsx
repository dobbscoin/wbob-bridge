'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchReserves, fmtBob, fmtRatio, timeAgo, type ReservesReport } from '@/lib/reserves-client';

/**
 * Slim proof-of-reserves strip for the home page.
 *
 * With motion allowed, one line cycles through the four readings (CSS only, see
 * .reserves-ticker in globals.css). With prefers-reduced-motion, all four sit
 * still in a row. Both are always rendered and CSS picks one, so nothing jumps
 * after hydration. Screen readers get one plain sentence instead of either.
 */
export function ReservesTicker() {
  const { data, isError } = useQuery({
    queryKey: ['reserves'],
    queryFn: fetchReserves,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Re-render every 15 s so "Checked N ago" keeps counting between fetches.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const items = tickerItems(data, isError);
  const spoken = items.join('. ') + '.';

  return (
    <section
      aria-label="Proof of reserves"
      className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-bob-700/40 bg-bob-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-bob-300">
          Reserves
        </span>

        <p className="sr-only">{spoken}</p>

        {/* Motion: one line at a time, fixed height, so the card never changes size. */}
        <div
          aria-hidden="true"
          className="reserves-ticker motion-reduce:hidden order-3 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"
        >
          <ul className="reserves-ticker-track">
            {[...items, items[0]].map((t, i) => (
              <li key={i} className="reserves-ticker-item">{t}</li>
            ))}
          </ul>
        </div>

        {/* Reduced motion: everything at once, still. */}
        <ul
          aria-hidden="true"
          className="motion-safe:hidden order-3 grid w-full min-w-0 grid-cols-1 gap-x-4 gap-y-1 font-mono text-xs text-gray-300 sm:order-none sm:w-auto sm:flex-1 sm:grid-cols-2"
        >
          {items.map((t, i) => <li key={i} className="truncate">{t}</li>)}
        </ul>

        <Link
          href="/reserves"
          className="ml-auto shrink-0 text-xs text-bob-400 hover:underline focus:outline-none focus:ring-2 focus:ring-bob-400 rounded"
        >
          How this is checked →
        </Link>
      </div>
    </section>
  );
}

function tickerItems(r: ReservesReport | undefined, failed: boolean): string[] {
  if (!r) {
    const msg = failed ? 'Reserves could not be read just now' : 'Reading both chains…';
    return [msg, msg, msg, msg];
  }
  const staleNote = (stale: boolean, at: string | null) =>
    stale && at ? ` (stale, read ${timeAgo(at)})` : '';
  return [
    r.bobReserve !== null
      ? `(BOB) in the bridge: ${fmtBob(r.bobReserve)}${staleNote(r.stale.bob, r.bobCheckedAt)}`
      : '(BOB) in the bridge: unreadable right now',
    r.wbobSupply !== null
      ? `wBOB on Gnosis: ${fmtBob(r.wbobSupply)}${staleNote(r.stale.gnosis, r.gnosisCheckedAt)}`
      : 'wBOB on Gnosis: unreadable right now',
    r.ratio !== null
      ? `Backing: ${fmtRatio(r.ratio, 2)} to 1`
      : 'Backing: not computed, one side is missing',
    `Checked ${timeAgo(r.checkedAt)}`,
  ];
}
