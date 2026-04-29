'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import {
  getDepositAddress,
  getDripStatus,
  listOrdersByRecipient,
  type DripStatusResponse,
  type OrderResponse,
} from '@/lib/api';
import { satsToBob } from '@/lib/utils';
import Link from 'next/link';
import { OnboardingPanel } from '@/components/OnboardingPanel';
import { NFADisclaimer } from '@/components/NFADisclaimer';

const ACTIVE_STATES = new Set([
  'DEPOSIT_SEEN_MEMPOOL',
  'DEPOSIT_CONFIRMED',
  'DEPOSIT_FINALIZED',
  'MINT_AUTH_CREATED',
  'MINT_SUBMITTED',
  'MINT_CONFIRMED',
]);

const GNOSIS_FAUCET_URL = 'https://faucet.gnosischain.com/';

export default function TestBedPage() {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);
  const [optInDrip, setOptInDrip] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  // Reset confirmation when wallet changes
  useEffect(() => {
    setConfirmed(false);
  }, [address]);

  const { data: depositInfo, isLoading: loadingAddress } = useQuery({
    queryKey: ['deposit-address', address, optInDrip],
    queryFn: () => getDepositAddress(address!, optInDrip),
    enabled: !!address && confirmed,
    staleTime: 24 * 60 * 60 * 1000,
  });

  const { data: dripStatus } = useQuery({
    queryKey: ['drip-status', address],
    queryFn: () => getDripStatus(address!),
    enabled: !!address && confirmed,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll faster while drip is pending; slower (or stop) once terminal.
      if (status === 'opted_in' || status === 'wallet_dry') return 15_000;
      return 60_000;
    },
  });

  const { data: history } = useQuery({
    queryKey: ['orders-by-recipient', address],
    queryFn: () => listOrdersByRecipient(address!),
    enabled: !!address && confirmed,
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Top row: Hero + connect (left) ◇ One-click setup (right) */}
      <div className="grid md:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-bob-700/40 bg-bob-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-bob-300">
              Praise &quot;Bob&quot;
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Bridge &amp; Fuel</h1>
            <p className="text-sm text-gray-400">
              Bridge (BOB) → wBOB on Gnosis, then trade a sliver for WXDAI so
              you can transact without hunting for gas. Same bridge, lower
              learning curve.
            </p>
          </div>

          <NFADisclaimer />

          <div className="card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
              Step 0 — Connect a wallet
            </h2>
            {address ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs text-gray-300">
                Connected as{' '}
                <code className="font-mono text-bob-300 break-all">{address}</code>
              </div>
            ) : (
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button onClick={openConnectModal} className="btn-primary w-full">
                    Connect wallet
                  </button>
                )}
              </ConnectButton.Custom>
            )}
          </div>
        </div>

        <OnboardingPanel />
      </div>

      {/* Steps row: Step 1 (bridge in) ◇ Step 2 (trade link) */}
      <div className="grid md:grid-cols-2 gap-6 items-start">
        {/* Step 1 — bridge in (with drip opt-in checkbox before allocation) */}
        <div className="card space-y-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
              Step 1 — Bridge (BOB) in
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Connect a wallet to get a permanent Dobbscoin deposit address.
              Send any amount; wBOB lands on Gnosis after 6 confirmations
              (~6 minutes).
            </p>
          </div>

          {!address ? (
            <p className="text-xs text-gray-500">Connect above to continue.</p>
          ) : !confirmed ? (
            <DripOptInForm
              optIn={optInDrip}
              onToggle={setOptInDrip}
              onConfirm={() => setConfirmed(true)}
            />
          ) : loadingAddress || !depositInfo ? (
            <p className="text-sm text-gray-500 animate-pulse">Resolving your address…</p>
          ) : (
            <>
              <div className="space-y-1">
                <p className="label">Dobbscoin deposit address</p>
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
              </div>
              <div className="text-xs text-gray-400 space-y-1 border-t border-gray-800 pt-3">
                <p>• Send <span className="text-gray-200 font-medium">any amount</span> of (BOB).</p>
                <p>• wBOB will mint to {depositInfo.recipientAddress.slice(0, 10)}… on Gnosis.</p>
                <p>• Reusable forever. No approval. No expiry.</p>
              </div>
            </>
          )}
        </div>

        {/* Step 2 — trade link */}
        <Link
          href="/trade"
          className="card flex flex-col justify-between space-y-3 group hover:border-bob-600 transition-colors"
        >
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400 group-hover:text-bob-400 transition-colors">
              Step 2 — Trade wBOB
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Once your wBOB lands and your wallet has gas, head over to the
              trade page — embedded CoW Swap and Oku, both routed on Gnosis.
              Bridge takes no fee.
            </p>
          </div>
          <ul className="text-xs text-gray-400 space-y-1">
            <li>• CoW Swap — wBOB → WXDAI</li>
            <li>• Oku — WXDAI → wBOB</li>
            <li>• Both need xDAI for gas (see below).</li>
          </ul>
          <p className="text-xs text-bob-400 group-hover:underline">
            Open trade page →
          </p>
        </Link>
      </div>

      {/* Drip status — appears once allocated */}
      {address && confirmed && dripStatus && dripStatus.enabled && (
        <DripStatusCard status={dripStatus} />
      )}

      {/* Wide tx history */}
      {address && history && history.orders.filter((o) => o.orderType === 'inbound').length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
              Your deposits
            </h2>
            <span className="text-[11px] text-gray-500">
              {history.orders.filter((o) => o.orderType === 'inbound').length} total
            </span>
          </div>
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {history.orders
              .filter((o) => o.orderType === 'inbound')
              .map((o) => (
                <OrderRow key={o.orderId} order={o} />
              ))}
          </ul>
        </div>
      )}

      <div className="mx-auto max-w-2xl space-y-6">
        <div className="card space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            About this bridge
          </h3>
          <ul className="text-xs text-gray-500 space-y-1">
            <li>• 3-of-5 watcher signatures required to mint wBOB; admin role held by a Gnosis Safe.</li>
            <li>
              • Contracts source-verified on{' '}
              <a
                href="https://gnosisscan.io/address/0x13550ae65f22A36f60A50d625B70b58666488263#code"
                target="_blank"
                rel="noopener noreferrer"
                className="text-bob-400 hover:underline"
              >
                Gnosisscan
              </a>
              .
            </li>
            <li>• Trades on the trade page are routed by third-party DEXs (CoW Swap, Oku). The bridge takes no fee on swaps.</li>
            <li>• (BOB) is not for sale — it is for trade.</li>
          </ul>
          <NFADisclaimer compact />
        </div>
      </div>
    </div>
  );
}

// ─── DripOptInForm ────────────────────────────────────────────────────────────

function DripOptInForm({
  optIn,
  onToggle,
  onConfirm,
}: {
  optIn: boolean;
  onToggle: (v: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-3 cursor-pointer hover:border-bob-700/60 transition-colors">
        <input
          type="checkbox"
          checked={optIn}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-800 text-bob-500 focus:ring-bob-500"
        />
        <span className="flex-1 space-y-1">
          <span className="block text-sm font-medium text-gray-100">
            Drip me xDAI for gas on my first bridge
          </span>
          <span className="block text-xs text-gray-500">
            On your <span className="text-gray-300">first</span> wBOB mint, the
            bridge will send you a small amount of native xDAI so you can
            transact on Gnosis without hunting for gas. One-time per address.
            Bridge eats the cost. No tracking; no obligation.
          </span>
        </span>
      </label>

      <button onClick={onConfirm} className="btn-primary w-full">
        {optIn ? 'Get my deposit address & drip' : 'Get my deposit address'}
      </button>

      <p className="text-[11px] text-gray-500">
        Locked at first allocation — once chosen, this preference is permanent
        for this address. Verify the contracts on{' '}
        <a
          href="https://gnosisscan.io/address/0x13550ae65f22A36f60A50d625B70b58666488263#code"
          target="_blank"
          rel="noopener noreferrer"
          className="text-bob-400 hover:underline"
        >
          Gnosisscan
        </a>
        .
      </p>
    </div>
  );
}

// ─── DripStatusCard ───────────────────────────────────────────────────────────

function DripStatusCard({ status }: { status: DripStatusResponse }) {
  const variant: { tone: string; title: string; body: React.ReactNode } = (() => {
    switch (status.status) {
      case 'opted_in':
        return {
          tone: 'pending',
          title: 'Gas drip pending',
          body: (
            <>
              You opted in. The drip will arrive automatically with your first
              wBOB mint. Bridge a qualifying amount and check back here.
            </>
          ),
        };
      case 'sent':
        return {
          tone: 'done',
          title: 'Gas drip received',
          body: (
            <>
              Native xDAI dropped into your wallet for first-mint gas.{' '}
              {status.gnosisTxHash && (
                <a
                  href={`https://gnosisscan.io/tx/${status.gnosisTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-bob-400 hover:underline"
                >
                  view tx ↗
                </a>
              )}
            </>
          ),
        };
      case 'opted_out':
        return {
          tone: 'neutral',
          title: 'Drip declined',
          body: (
            <>
              You opted out at allocation. If you need gas, the{' '}
              <a
                href={GNOSIS_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bob-400 hover:underline"
              >
                public Gnosis faucet
              </a>{' '}
              hands out a small amount of xDAI to any address.
            </>
          ),
        };
      case 'wallet_dry':
        return {
          tone: 'warning',
          title: 'Drip pool empty right now',
          body: (
            <>
              The drip wallet is being refilled. Your mint already completed —
              ops have been pinged. In the meantime, the{' '}
              <a
                href={GNOSIS_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bob-400 hover:underline"
              >
                public Gnosis faucet
              </a>{' '}
              is the fastest way to get gas.
            </>
          ),
        };
      case 'failed':
        return {
          tone: 'warning',
          title: 'Drip failed',
          body: (
            <>
              The drip transaction reverted on-chain. Your mint was unaffected.
              Use the{' '}
              <a
                href={GNOSIS_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bob-400 hover:underline"
              >
                public Gnosis faucet
              </a>{' '}
              for now.
            </>
          ),
        };
      case 'no_record':
      default:
        return {
          tone: 'neutral',
          title: 'No drip configured',
          body: (
            <>
              This address pre-dates the drip program — no automatic top-up is
              attached. You can use the{' '}
              <a
                href={GNOSIS_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bob-400 hover:underline"
              >
                public Gnosis faucet
              </a>{' '}
              for gas.
            </>
          ),
        };
    }
  })();

  const toneClass = {
    pending:  'border-yellow-900/40 bg-yellow-950/20',
    done:     'border-bob-700/40 bg-bob-500/5',
    neutral:  'border-gray-800 bg-gray-900/40',
    warning:  'border-red-900/40 bg-red-950/20',
  }[variant.tone] ?? 'border-gray-800 bg-gray-900/40';

  return (
    <div className={`card ${toneClass} space-y-2`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-300">
          {variant.title}
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-gray-500">
          gas drip
        </span>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">{variant.body}</p>
    </div>
  );
}

// ─── OrderRow (existing) ─────────────────────────────────────────────────────

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
