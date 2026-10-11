'use client';

// ─── RefundBanner ────────────────────────────────────────────────────────────
//
// btcbob, 2026-10: "Refund any (BOB) over the daily limit, process what you
// can.. and call attention to it vividly in the bridge transaction incoming
// area."
//
// Sits at the top of every inbound order that the daily mint cap split. Vivid
// by colour and type, not by more boxes ("trim, not boxy"): a heavy left rule
// and loud headline inside whatever row or card already holds the order.
// Amber while the refund is on its way or done; red when it needs a human.

import type { OrderResponse, RefundState } from '@/lib/api';
import { fmtBob, shortHash, dobbscoinExplorerTx, dobbscoinExplorerAddress } from '@/lib/utils';

const STATE_TEXT: Record<RefundState, string> = {
  queued:          'Refund queued — sending shortly',
  broadcast:       'Refund sent — confirming on Dobbscoin',
  confirmed:       'Refund confirmed',
  needs_attention: 'Refund held for manual review — the operator has been paged',
  too_small:       'Too small to refund — the excess is under the network fee',
};

export function hasRefund(order: OrderResponse): boolean {
  return order.orderType === 'inbound' && order.refundState !== null && order.refundSat !== null;
}

export function RefundBanner({ order, compact = false }: { order: OrderResponse; compact?: boolean }) {
  if (!hasRefund(order)) return null;
  const state = order.refundState!;
  const alarm = state === 'needs_attention';
  const tone = alarm
    ? { rule: 'border-red-500', head: 'text-red-400', body: 'text-red-100', strong: 'text-red-200', dim: 'text-red-200/70' }
    : { rule: 'border-amber-400', head: 'text-amber-400', body: 'text-amber-50', strong: 'text-amber-200', dim: 'text-amber-200/70' };

  const deposited = order.depositedSat ?? order.amountSat;
  const minted = order.mintedSat ?? '0';
  const refundAmount = order.refundSentSat ?? order.refundSat!;
  const onChain = (state === 'broadcast' || state === 'confirmed') && order.refundTxid;

  return (
    <div className={`border-l-4 ${tone.rule} pl-3 ${compact ? 'py-0.5' : 'py-1'} space-y-1`} role="status">
      <p className={`text-[11px] font-black uppercase tracking-[0.18em] ${tone.head}`}>
        ▲ Over today&apos;s mint cap
      </p>

      <p className={`${compact ? 'text-xs' : 'text-sm'} font-semibold leading-snug ${tone.body}`}>
        {deposited ? <>{fmtBob(deposited)} (BOB) deposited</> : 'Deposit received'}
        <span className={tone.dim}> · </span>
        {fmtBob(minted)} wBOB minted
        <span className={tone.dim}> · </span>
        <span className={tone.strong}>
          {state === 'too_small'
            ? <>{fmtBob(order.refundSat!)} (BOB) not refunded</>
            : <>{fmtBob(refundAmount)} (BOB) {state === 'confirmed' || state === 'broadcast' ? 'refunded' : 'to be refunded'}</>}
        </span>
        {order.refundAddress && state !== 'too_small' && (
          <>
            {' '}to{' '}
            <a
              href={dobbscoinExplorerAddress(order.refundAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-mono break-all underline decoration-dotted underline-offset-2 ${tone.strong}`}
            >
              {order.refundAddress}
            </a>
          </>
        )}
      </p>

      <p className={`flex flex-wrap items-baseline gap-x-2 text-[11px] ${tone.dim}`}>
        <span className={`font-bold uppercase tracking-wider ${tone.head}`}>{STATE_TEXT[state]}</span>
        {state === 'broadcast' && order.refundConfirmations !== null && (
          <span>{order.refundConfirmations} / 3 confirmations</span>
        )}
        {order.refundFeeSat && state !== 'too_small' && (
          <span>network fee {fmtBob(order.refundFeeSat)} (BOB)</span>
        )}
        {onChain && (
          <a
            href={dobbscoinExplorerTx(order.refundTxid!)}
            target="_blank"
            rel="noopener noreferrer"
            className={`font-mono hover:underline ${tone.strong}`}
          >
            refund tx {shortHash(order.refundTxid!, 6)} ↗
          </a>
        )}
      </p>

      {!compact && state !== 'too_small' && (
        <p className={`text-[11px] leading-relaxed ${tone.dim}`}>
          wBOB has a daily mint limit. What fit under today&apos;s cap was minted;
          the rest goes back to the address it was sent from, less the Dobbscoin network fee.
          {state === 'needs_attention' && !order.refundAddress &&
            ' The bridge could not tell for certain which address sent this, so it did not guess.'}
        </p>
      )}
    </div>
  );
}
