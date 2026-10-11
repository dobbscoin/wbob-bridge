'use client';

import { useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import { getDepositAddress, listOrdersByRecipient, refundInFlight, type OrderResponse } from '@/lib/api';
import { satsToBob } from '@/lib/utils';
import { MintCapPanel } from '@/components/MintCapPanel';
import { RefundBanner } from '@/components/RefundBanner';

const ACTIVE_STATES = new Set([
  'DEPOSIT_SEEN_MEMPOOL',
  'DEPOSIT_CONFIRMED',
  'DEPOSIT_FINALIZED',
  'MINT_AUTH_CREATED',
  'MINT_SUBMITTED',
  'MINT_CONFIRMED',
]);

export default function DepositPage() {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);

  // Resolve (or allocate) the persistent deposit address for the connected wallet
  const { data: depositInfo, isLoading: loadingAddress } = useQuery({
    queryKey: ['deposit-address', address],
    queryFn: () => getDepositAddress(address!),
    enabled: !!address,
    staleTime: 24 * 60 * 60 * 1000, // address is permanent; cache a day
  });

  // Poll the user's order history. Faster cadence while any order is active.
  const { data: history } = useQuery({
    queryKey: ['orders-by-recipient', address],
    queryFn: () => listOrdersByRecipient(address!),
    enabled: !!address,
    refetchInterval: (query) => {
      const anyActive = query.state.data?.orders.some(
        (o) => o.orderType === 'inbound' && (ACTIVE_STATES.has(o.state) || refundInFlight(o)),
      );
      return anyActive ? 10_000 : 60_000;
    },
  });

  const copyAddress = useCallback(() => {
    if (!depositInfo) return;
    navigator.clipboard.writeText(depositInfo.depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [depositInfo]);

  // ── Wallet not connected ──────────────────────────────────────────────
  if (!address) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Deposit BOB</h1>
          <p className="text-sm text-gray-400 mt-1">
            Connect your Gnosis wallet to see your permanent Dobbscoin deposit address.
          </p>
        </div>
        <div className="card text-center">
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button onClick={openConnectModal} className="btn-primary w-full">
                Connect wallet
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deposit BOB</h1>
        <p className="text-sm text-gray-400 mt-1">
          Your permanent Dobbscoin deposit address. Up to today&apos;s remaining
          mint cap is minted as wBOB; anything over is refunded to the sending
          address, minus the network fee.
        </p>
      </div>

      <div className="card">
        <MintCapPanel />
      </div>

      {/* ── Persistent address card ─────────────────────────────────── */}
      <div className="card space-y-4">
        <div className="space-y-1">
          <p className="label">Dobbscoin deposit address</p>
          {loadingAddress || !depositInfo ? (
            <p className="text-sm text-gray-500 animate-pulse">Resolving your address…</p>
          ) : (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-xs font-mono text-bob-300 break-all">
                {depositInfo.depositAddress}
              </code>
              <button
                onClick={copyAddress}
                className="shrink-0 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          )}
        </div>

        <div className="text-xs text-gray-400 space-y-1 border-t border-gray-800 pt-3">
          <p>• Up to <span className="text-gray-200 font-medium">today&apos;s remaining cap</span> (above) mints as wBOB on Gnosis ({depositInfo?.recipientAddress.slice(0, 10)}…).</p>
          <p>• Anything over the cap is <span className="text-amber-300 font-medium">refunded to the address you sent from</span>, minus the Dobbscoin network fee. Send from a wallet you control, not an exchange.</p>
          <p>• Deposits are credited after 60 Dobbscoin confirmations (~2 hours).</p>
          <p>• Reusable — deposit as many times as you like.</p>
        </div>
      </div>

      {/* ── History ────────────────────────────────────────────────── */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Your deposits
        </h2>
        {history === undefined ? (
          <p className="text-sm text-gray-500 animate-pulse">Loading…</p>
        ) : history.orders.filter((o) => o.orderType === 'inbound').length === 0 ? (
          <p className="text-sm text-gray-500">No deposits yet. Send BOB to the address above to get started.</p>
        ) : (
          <ul className="space-y-2">
            {history.orders
              .filter((o) => o.orderType === 'inbound')
              .map((o) => (
                <OrderRow key={o.orderId} order={o} />
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OrderRow({ order }: { order: OrderResponse }) {
  const displayState = order.state.replace(/_/g, ' ').toLowerCase();
  const isDone = order.state === 'COMPLETED';
  const isFailed = ['FAILED', 'MANUAL_REVIEW'].includes(order.state);
  const stateColor = isDone
    ? 'text-bob-400'
    : order.state === 'REFUNDED'
      ? 'text-amber-400'
      : isFailed
        ? 'text-red-400'
        : 'text-yellow-400';

  const split = order.refundState !== null;
  return (
    <li
      className={`rounded-lg border bg-gray-900/40 px-3 py-2 text-xs ${
        order.refundState === 'needs_attention' ? 'border-red-500/70'
          : split ? 'border-amber-400/70' : 'border-gray-800'
      }`}
    >
      {split && (
        <div className="mb-2">
          <RefundBanner order={order} compact />
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-bob-300">
          {order.amountSat ? satsToBob(order.amountSat) : '—'} BOB
        </span>
        <span className={`capitalize ${stateColor}`}>{displayState}</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[10px] text-gray-500">
        <span>{new Date(order.createdAt).toLocaleString()}</span>
        {order.gnosisTxHash && (
          <a
            href={`https://gnosisscan.io/tx/${order.gnosisTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-bob-400 hover:underline"
          >
            mint tx ↗
          </a>
        )}
      </div>
    </li>
  );
}
