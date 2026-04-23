'use client';

import { useState, useCallback } from 'react';
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import { parseEventLogs } from 'viem';
import { getOrder, getOrderByWithdrawal, type OrderResponse } from '@/lib/api';
import { satsToBob, bobToSats, gnosisExplorerTx, shortHash } from '@/lib/utils';
import { WBOB_ABI, BRIDGE_CONTROLLER_ABI, WBOB_ADDRESS, BRIDGE_CONTROLLER_ADDRESS } from '@/lib/contracts';
import { OrderProgress } from '@/components/OrderProgress';

type Phase =
  | { tag: 'form' }
  | { tag: 'signing' }
  | { tag: 'submitted'; txHash: `0x${string}` }
  | { tag: 'confirmed'; txHash: `0x${string}` }
  | { tag: 'polling'; orderId: string }
  | { tag: 'completed'; order: OrderResponse };

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'MANUAL_REVIEW']);

// Validate Dobbscoin P2PKH address (starts with 1 or m/n, 25-34 chars)
function isValidDobbscoinAddress(addr: string): boolean {
  return /^[1mn][1-9A-HJ-NP-Za-km-z]{24,33}$/.test(addr);
}

export default function WithdrawPage() {
  const { address } = useAccount();
  const [phase, setPhase] = useState<Phase>({ tag: 'form' });
  const [amountBob, setAmountBob] = useState('');
  const [dobbscoinAddress, setDobbscoinAddress] = useState('');
  const [formError, setFormError] = useState('');

  // ── Read wBOB balance ──────────────────────────────────────────────────────
  const { data: balanceSat } = useReadContract({
    address: WBOB_ADDRESS || undefined,
    abi: WBOB_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!WBOB_ADDRESS },
  });

  // ── Write: requestWithdrawal ───────────────────────────────────────────────
  const { writeContractAsync, isPending: isSigning } = useWriteContract();

  // ── Wait for tx confirmation ───────────────────────────────────────────────
  const txHash = phase.tag === 'submitted' ? phase.txHash : undefined;
  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // When receipt arrives, extract withdrawalId and start polling
  const [lookupWithdrawalId, setLookupWithdrawalId] = useState<string | null>(null);

  if (receipt && phase.tag === 'submitted') {
    try {
      const logs = parseEventLogs({
        abi: BRIDGE_CONTROLLER_ABI,
        logs: receipt.logs,
        eventName: 'WithdrawalRequested',
      });
      const withdrawalId = (logs[0]?.args as { withdrawalId?: bigint })?.withdrawalId?.toString();
      if (withdrawalId && withdrawalId !== lookupWithdrawalId) {
        setLookupWithdrawalId(withdrawalId);
        setPhase({ tag: 'confirmed', txHash: phase.txHash });
      }
    } catch {
      // event not found — still show confirmed state
      setPhase({ tag: 'confirmed', txHash: phase.txHash });
    }
  }

  // Poll backend for order (after confirmed)
  const { data: withdrawalLookup } = useQuery({
    queryKey: ['withdrawal', lookupWithdrawalId],
    queryFn: () => getOrderByWithdrawal(lookupWithdrawalId!),
    enabled: !!lookupWithdrawalId && phase.tag === 'confirmed',
    refetchInterval: 8_000,
    retry: 20,
  });

  if (withdrawalLookup && phase.tag === 'confirmed') {
    setPhase({ tag: 'polling', orderId: withdrawalLookup.orderId });
  }

  // Poll order status
  const orderId = phase.tag === 'polling' ? phase.orderId : null;
  const { data: orderData } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId!),
    enabled: !!orderId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && TERMINAL.has(state) ? false : 12_000;
    },
  });

  if (orderData?.state === 'COMPLETED' && phase.tag === 'polling') {
    setPhase({ tag: 'completed', order: orderData });
  }

  // ── Submit withdrawal ──────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!WBOB_ADDRESS || !BRIDGE_CONTROLLER_ADDRESS) {
      setFormError('Contract addresses not configured. Check .env settings.');
      return;
    }

    let amountSat: bigint;
    try {
      amountSat = bobToSats(amountBob);
      if (amountSat <= 0n) throw new Error();
    } catch {
      setFormError('Enter a valid BOB amount');
      return;
    }

    if (balanceSat !== undefined && amountSat > (balanceSat as bigint)) {
      setFormError(`Insufficient balance. You have ${satsToBob(balanceSat as bigint)} wBOB.`);
      return;
    }

    if (!isValidDobbscoinAddress(dobbscoinAddress)) {
      setFormError('Enter a valid Dobbscoin address (starts with 1, m, or n)');
      return;
    }

    setPhase({ tag: 'signing' });
    try {
      const hash = await writeContractAsync({
        address: BRIDGE_CONTROLLER_ADDRESS,
        abi: BRIDGE_CONTROLLER_ABI,
        functionName: 'requestWithdrawal',
        args: [amountSat, dobbscoinAddress],
      });
      setPhase({ tag: 'submitted', txHash: hash });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setFormError(msg.length > 120 ? msg.slice(0, 120) + '…' : msg);
      setPhase({ tag: 'form' });
    }
  }, [amountBob, dobbscoinAddress, balanceSat, writeContractAsync]);

  // ── Completed ───────────────────────────────────────────────────────────────
  if (phase.tag === 'completed') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-bold">Withdraw BOB</h1>
        <div className="card text-center space-y-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-bob-500/20">
            <svg className="h-8 w-8 text-bob-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-lg font-semibold text-bob-400">
              {satsToBob(phase.order.amountSat ?? '0')} BOB sent
            </p>
            <p className="text-sm text-gray-400 mt-1">
              Paid out on Dobbscoin
            </p>
          </div>
          <button onClick={() => { setPhase({ tag: 'form' }); setLookupWithdrawalId(null); }} className="btn-secondary">
            Make another withdrawal
          </button>
        </div>
      </div>
    );
  }

  // ── Polling order ────────────────────────────────────────────────────────────
  if (phase.tag === 'polling') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-bold">Withdraw BOB</h1>
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Progress</h2>
          {orderData ? (
            <OrderProgress order={orderData} />
          ) : (
            <p className="text-sm text-gray-500 animate-pulse">Processing withdrawal…</p>
          )}
        </div>
        <p className="text-center text-xs text-gray-600">Order ID: {phase.orderId}</p>
      </div>
    );
  }

  // ── Submitted / confirmed (waiting for backend) ──────────────────────────────
  if (phase.tag === 'submitted' || phase.tag === 'confirmed') {
    const txH = phase.txHash;
    const isConfirmed = phase.tag === 'confirmed';
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-bold">Withdraw BOB</h1>
        <div className="card space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-800">
            <svg className="h-6 w-6 text-bob-400 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
          </div>
          <p className="font-medium">
            {isConfirmed ? 'Confirmed! Waiting for backend…' : 'Waiting for confirmation…'}
          </p>
          <a
            href={gnosisExplorerTx(txH)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-bob-400 hover:underline"
          >
            {shortHash(txH, 10)} on Gnosisscan ↗
          </a>
          <p className="text-xs text-gray-500">
            The bridge backend will pick up your withdrawal and queue the Dobbscoin payout.
          </p>
        </div>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Withdraw BOB</h1>
        <p className="text-sm text-gray-400 mt-1">
          Burn wBOB on Gnosis. The bridge pays out BOB to your Dobbscoin address.
        </p>
      </div>

      {!address ? (
        <div className="card flex flex-col items-center gap-4 py-10">
          <p className="text-gray-400">Connect your Gnosis wallet to withdraw.</p>
          <ConnectButton />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="card space-y-5">
          {/* Balance display */}
          {balanceSat !== undefined && (
            <div className="rounded-lg bg-gray-800 px-4 py-3 flex items-center justify-between">
              <span className="text-xs text-gray-400">Your wBOB balance</span>
              <span className="text-sm font-semibold text-bob-300">
                {satsToBob(balanceSat as bigint)} wBOB
              </span>
            </div>
          )}

          {/* Amount */}
          <div>
            <label className="label">Amount to withdraw (wBOB)</label>
            <div className="relative">
              <input
                type="text"
                className="input-field pr-16"
                placeholder="0.00000000"
                value={amountBob}
                onChange={(e) => setAmountBob(e.target.value)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
                wBOB
              </span>
            </div>
            {balanceSat !== undefined && (
              <button
                type="button"
                onClick={() => setAmountBob(satsToBob(balanceSat as bigint))}
                className="mt-1 text-xs text-bob-400 hover:text-bob-300"
              >
                Max: {satsToBob(balanceSat as bigint)}
              </button>
            )}
          </div>

          {/* Dobbscoin address */}
          <div>
            <label className="label">Dobbscoin destination address</label>
            <input
              type="text"
              className="input-field font-mono"
              placeholder="1YourDobbscoinAddress..."
              value={dobbscoinAddress}
              onChange={(e) => setDobbscoinAddress(e.target.value)}
            />
          </div>

          {formError && <p className="text-sm text-red-400">{formError}</p>}

          <button
            type="submit"
            disabled={isSigning || phase.tag === 'signing'}
            className="btn-primary w-full"
          >
            {isSigning || phase.tag === 'signing' ? 'Confirm in wallet…' : 'Withdraw BOB'}
          </button>

          <p className="text-xs text-gray-600 text-center">
            Your wBOB will be burned. BOB is paid out by the bridge on Dobbscoin.
          </p>
        </form>
      )}
    </div>
  );
}
