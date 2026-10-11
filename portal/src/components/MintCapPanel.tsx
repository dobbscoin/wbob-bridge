'use client';

// ─── MintCapPanel ────────────────────────────────────────────────────────────
//
// wBOB has a daily mint limit (1,000,000 at launch, set on the contract, reset at
// 00:00 UTC). Users send to a permanent address and never declare an amount, so
// the portal cannot stop an over-cap send — it can only say, before they send,
// how much is left today and what happens to the rest: the part that fits is
// minted, anything over is refunded to the address it came from, less the
// Dobbscoin network fee.
//
// "Left today" comes from the backend (/v1/mint-cap): the chain's remaining
// allowance minus mints the bridge has already authorized but not executed —
// the same number the bridge splits a new deposit against.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMintCap } from '@/lib/api';
import { fmtBob, fmtCountdown } from '@/lib/utils';

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function MintCapPanel({ className = '' }: { className?: string }) {
  const { data, isError, refetch } = useQuery({
    queryKey: ['mint-cap'],
    queryFn: getMintCap,
    refetchInterval: 30_000,
  });
  const now = useNow();

  // Refetch right after the reset so "left today" jumps back without a reload.
  const resetsAtMs = data ? Date.parse(data.resetsAt) : null;
  useEffect(() => {
    if (resetsAtMs === null) return;
    const ms = resetsAtMs - Date.now() + 5_000;
    if (ms <= 0 || ms > 2 ** 31 - 1) return;
    const id = setTimeout(() => { void refetch(); }, ms);
    return () => clearTimeout(id);
  }, [resetsAtMs, refetch]);

  if (isError && !data) {
    return (
      <p className={`text-xs text-gray-500 ${className}`}>
        Today&apos;s mint cap could not be read right now. Deposits over what is left
        today are minted up to the cap; the rest is refunded to the sending address.
      </p>
    );
  }

  if (!data) {
    return <p className={`text-xs text-gray-500 animate-pulse ${className}`}>Reading today&apos;s mint cap…</p>;
  }

  const limit = BigInt(data.limitSat);
  const used = BigInt(data.mintedTodaySat) + BigInt(data.reservedSat);
  const left = BigInt(data.remainingSat);
  const usedPct = limit > 0n ? Math.min(100, Number((used * 10_000n) / limit) / 100) : 100;
  const secsToReset = resetsAtMs === null ? 0 : (resetsAtMs - now) / 1000;
  const spent = left === 0n;

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">
          Today&apos;s mint cap
        </p>
        <p className="text-[11px] text-gray-500">
          resets in{' '}
          <span className="font-mono font-semibold text-gray-200 tabular-nums">
            {fmtCountdown(secsToReset)}
          </span>{' '}
          <span className="text-gray-600">(00:00 UTC)</span>
        </p>
      </div>

      <p className={`text-2xl font-bold tabular-nums ${spent ? 'text-red-400' : 'text-bob-300'}`}>
        {fmtBob(left)}
        <span className="ml-1.5 text-sm font-semibold text-gray-400">wBOB left today</span>
      </p>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800" aria-hidden>
        <div
          className={`h-full rounded-full ${spent ? 'bg-red-500' : 'bg-bob-500'}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>

      <p className="text-[11px] text-gray-500 tabular-nums">
        {fmtBob(used)} of {fmtBob(limit)} used
        {BigInt(data.reservedSat) > 0n && (
          <> · {fmtBob(BigInt(data.reservedSat))} of that is minting now</>
        )}
      </p>

      <p className={`text-xs leading-relaxed ${spent ? 'text-red-200' : 'text-amber-200/90'}`}>
        {spent ? (
          <>
            <span className="font-semibold text-red-300">Nothing more mints today.</span>{' '}
            A deposit sent before the reset is refunded in full to the address it
            came from, minus the Dobbscoin network fee.
          </>
        ) : (
          <>
            Up to <span className="font-semibold text-amber-100">{fmtBob(left)} (BOB)</span> mints
            today. Anything over that is{' '}
            <span className="font-semibold text-amber-100">refunded to the sending address</span>,
            minus the Dobbscoin network fee.
          </>
        )}
      </p>
    </div>
  );
}
