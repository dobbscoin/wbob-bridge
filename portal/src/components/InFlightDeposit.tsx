'use client';

// ─── InFlightDeposit ─────────────────────────────────────────────────────────
//
// The LANDING-ZONE reassurance block. btcbob, 2026-08-25, on sending 808 BOB and
// seeing only a ledger row: *"I need the LANDING ZONE to drop down and have a
// block within it that says 'you just sent blah blah has been received' so people
// can rest assured they are safu."*
//
// "Your deposits" is a ledger — correct, but it reads as history, not as a live
// receipt. Someone who has just pushed real money at an address needs to be told,
// prominently and in the first place they look, that it ARRIVED and is moving.
//
// Renders only while an inbound order is mid-flight. Once COMPLETED it disappears
// and the ledger row is the right home for it.

import type { OrderResponse } from '@/lib/api';

const SAT = 100_000_000;

// MIN_CONFIRMATIONS=30 -> DEPOSIT_CONFIRMED ; FINAL_CONFIRMATIONS=60 -> mint.
const MIN_CONFS = 30;
const FINAL_CONFS = 60;

const STAGES = [
  { state: 'DEPOSIT_SEEN_MEMPOOL', label: 'Received',        blurb: 'Your transaction is on the Dobbscoin chain.' },
  { state: 'DEPOSIT_CONFIRMED',    label: 'Confirmed',       blurb: 'Past 30 confirmations. Now hardening to 60.' },
  { state: 'DEPOSIT_FINALIZED',    label: 'Finalized',       blurb: 'Past 60. The watchers are signing your mint.' },
  { state: 'MINT_AUTH_CREATED',    label: 'Mint authorized', blurb: 'Enough watchers signed. Minting on Gnosis.' },
  { state: 'MINT_SUBMITTED',       label: 'Minting',         blurb: 'Mint submitted to Gnosis. Nearly there.' },
  { state: 'MINT_CONFIRMED',       label: 'Minted',          blurb: 'wBOB is on Gnosis.' },
];

function fmt(amountSat: string | null | undefined) {
  // amountSat is nullable on the API type: an order exists from the moment a
  // deposit address is issued, before any amount is known.
  if (amountSat == null) return null;
  const n = Number(amountSat) / SAT;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

export function InFlightDeposit({ order }: { order: OrderResponse }) {
  const idx = Math.max(0, STAGES.findIndex((s) => s.state === order.state));
  const stage = STAGES[idx] ?? STAGES[0];
  const confs = order.confirmations ?? 0;

  // Before 30 we're climbing to "confirmed"; after, we're climbing to the mint.
  const target = confs < MIN_CONFS ? MIN_CONFS : FINAL_CONFS;
  const pct = Math.min(100, Math.round((confs / target) * 100));
  const remaining = Math.max(0, target - confs);

  return (
    <div className="relative overflow-hidden rounded-lg border-2 border-emerald-500/80 bg-black px-4 py-3">
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">
          <span aria-hidden>✓</span>
          Your deposit is in processing
        </p>

        <p className="text-base font-semibold text-emerald-100">
          {fmt(order.amountSat) === null
            ? 'Deposit received'
            : fmt(order.amountSat) + ' (BOB) received'}
        </p>

        <p className="text-xs leading-relaxed text-emerald-100/90">
          {stage.blurb} Your funds are locked and accounted for — you can close
          this page and come back; nothing is lost while you wait.
        </p>

        {/* progress toward the next gate */}
        <div className="space-y-1 pt-0.5">
          <div className="flex items-baseline justify-between text-[11px] text-emerald-200/80">
            <span className="font-semibold uppercase tracking-wider">{stage.label}</span>
            <span>
              {confs} / {target} confirmations
              {remaining > 0 ? ` · ${remaining} to go` : ' · done'}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-950">
            <div
              className="h-full rounded-full bg-emerald-400 transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* the ladder, so the wait has a visible shape */}
        <ol className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] uppercase tracking-wider">
          {STAGES.map((s, i) => (
            <li
              key={s.state}
              className={
                i < idx ? 'text-emerald-500/70'
                  : i === idx ? 'font-bold text-emerald-300'
                    : 'text-gray-600'
              }
            >
              {i < idx ? '✓ ' : i === idx ? '▸ ' : '· '}{s.label}
            </li>
          ))}
        </ol>

        <p className="pt-0.5 text-[10px] leading-relaxed text-emerald-100/50">
          Confirmations accrue as Dobbscoin blocks are mined. The wait is
          51%-attack hardening, not a stuck bridge.
        </p>
      </div>
    </div>
  );
}
