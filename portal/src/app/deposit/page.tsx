'use client';

import { useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import { getDepositAddress, listOrdersByRecipient, type OrderResponse } from '@/lib/api';
import { satsToBob } from '@/lib/utils';

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
        (o) => o.orderType === 'inbound' && ACTIVE_STATES.has(o.state),
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
          Your permanent Dobbscoin deposit address — send any amount, any time.
        </p>
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
          <p>• Send <span className="text-gray-200 font-medium">any amount</span> of BOB to this address.</p>
          <p>• You'll receive the exact amount sent as wBOB on Gnosis ({depositInfo?.recipientAddress.slice(0, 10)}…).</p>
          <p>• Deposits are credited after 6 Dobbscoin confirmations (~6 minutes).</p>
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
  const isFailed = ['FAILED', 'REFUNDED', 'MANUAL_REVIEW'].includes(order.state);
  const stateColor = isDone
    ? 'text-bob-400'
    : isFailed
      ? 'text-red-400'
      : 'text-yellow-400';

  return (
    <li className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs">
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
