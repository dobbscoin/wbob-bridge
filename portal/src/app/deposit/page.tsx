'use client';

import { useState, useCallback, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import { createQuote, getOrder, type QuoteResponse, type OrderResponse } from '@/lib/api';
import { satsToBob, bobToSats, formatExpiry } from '@/lib/utils';
import { OrderProgress } from '@/components/OrderProgress';

type Phase =
  | { tag: 'form' }
  | { tag: 'creating' }
  | { tag: 'pending'; quote: QuoteResponse; orderId: string }
  | { tag: 'completed'; order: OrderResponse };

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'REFUNDED']);

export default function DepositPage() {
  const { address } = useAccount();
  const [phase, setPhase] = useState<Phase>({ tag: 'form' });
  const [recipientAddress, setRecipientAddress] = useState('');
  const [amountBob, setAmountBob] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Pre-fill recipient from connected wallet
  useEffect(() => {
    if (address && !recipientAddress) setRecipientAddress(address);
  }, [address, recipientAddress]);

  // Poll order status
  const orderId = phase.tag === 'pending' ? phase.orderId : null;
  const { data: orderData } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId!),
    enabled: !!orderId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && TERMINAL.has(state) ? false : 12_000;
    },
  });

  useEffect(() => {
    if (!orderData) return;
    if (orderData.state === 'COMPLETED') {
      setPhase({ tag: 'completed', order: orderData });
    }
  }, [orderData]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!/^0x[0-9a-fA-F]{40}$/.test(recipientAddress)) {
      setError('Enter a valid Gnosis address (0x...)');
      return;
    }

    let amountSat: bigint;
    try {
      amountSat = bobToSats(amountBob);
      if (amountSat <= 0n) throw new Error('Amount must be positive');
    } catch {
      setError('Enter a valid BOB amount (e.g. 0.001)');
      return;
    }

    setPhase({ tag: 'creating' });
    try {
      const quote = await createQuote(recipientAddress, amountSat.toString());
      setPhase({ tag: 'pending', quote, orderId: quote.orderId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create quote');
      setPhase({ tag: 'form' });
    }
  }, [recipientAddress, amountBob]);

  const copyAddress = useCallback(() => {
    if (phase.tag !== 'pending') return;
    navigator.clipboard.writeText(phase.quote.depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [phase]);

  // ── Completed ───────────────────────────────────────────────────────────────
  if (phase.tag === 'completed') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-bold">Deposit BOB</h1>
        <div className="card text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-bob-500/20">
            <svg className="h-8 w-8 text-bob-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-lg font-semibold text-bob-400">
              {satsToBob(phase.order.amountSat ?? '0')} wBOB received
            </p>
            <p className="text-sm text-gray-400 mt-1">
              Delivered to {phase.order.recipientAddress?.slice(0, 10)}…
            </p>
          </div>
          {phase.order.gnosisTxHash && (
            <a
              href={`https://gnosisscan.io/tx/${phase.order.gnosisTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-bob-400 hover:underline"
            >
              View on Gnosisscan ↗
            </a>
          )}
          <button onClick={() => setPhase({ tag: 'form' })} className="btn-secondary">
            Make another deposit
          </button>
        </div>
      </div>
    );
  }

  // ── Pending (deposit address shown + polling) ────────────────────────────────
  if (phase.tag === 'pending') {
    const { quote } = phase;
    const currentOrder = orderData;

    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-bold">Deposit BOB</h1>

        {/* Deposit address card */}
        <div className="card space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-gray-400">Send exactly</p>
            <p className="text-2xl font-bold text-bob-400">{satsToBob(quote.amountSat)} BOB</p>
            <p className="text-xs text-gray-500">
              Expires in {formatExpiry(quote.expiresAt)}
            </p>
          </div>

          <div className="space-y-1">
            <p className="label">Dobbscoin deposit address</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-xs font-mono text-bob-300 break-all">
                {quote.depositAddress}
              </code>
              <button
                onClick={copyAddress}
                className="shrink-0 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <p className="text-xs text-gray-500 border-t border-gray-800 pt-3">
            Send exactly this amount. The bridge monitors for this deposit
            and will mint wBOB automatically once confirmed.
          </p>
        </div>

        {/* Progress */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Progress</h2>
          {currentOrder ? (
            <OrderProgress order={currentOrder} />
          ) : (
            <p className="text-sm text-gray-500 animate-pulse">Waiting for deposit…</p>
          )}
        </div>

        <p className="text-center text-xs text-gray-600">Order ID: {quote.orderId}</p>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deposit BOB</h1>
        <p className="text-sm text-gray-400 mt-1">
          Get a Dobbscoin deposit address. Once your BOB is confirmed, wBOB is minted to your Gnosis wallet.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card space-y-5">
        {/* Recipient */}
        <div>
          <label className="label">Recipient Gnosis address</label>
          <input
            type="text"
            className="input-field font-mono"
            placeholder="0x..."
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
          />
          {!address && (
            <p className="mt-1.5 text-xs text-gray-500">
              Or{' '}
              <span className="text-bob-400 cursor-pointer">connect your wallet</span>{' '}
              to auto-fill.
            </p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label className="label">Amount (BOB)</label>
          <div className="relative">
            <input
              type="text"
              className="input-field pr-14"
              placeholder="0.00000000"
              value={amountBob}
              onChange={(e) => setAmountBob(e.target.value)}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
              BOB
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Minimum: 0.00010000 BOB (10,000 sats)
          </p>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {!address ? (
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button type="button" onClick={openConnectModal} className="btn-primary w-full">
                Connect wallet to continue
              </button>
            )}
          </ConnectButton.Custom>
        ) : (
          <button
            type="submit"
            disabled={phase.tag === 'creating'}
            className="btn-primary w-full"
          >
            {phase.tag === 'creating' ? 'Creating deposit address…' : 'Get deposit address'}
          </button>
        )}
      </form>

      <div className="text-xs text-gray-600 space-y-1 text-center">
        <p>No approval needed. Send BOB directly to the provided address.</p>
        <p>Deposit addresses expire after 1 hour.</p>
      </div>
    </div>
  );
}
