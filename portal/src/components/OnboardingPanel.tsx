'use client';

import { useState } from 'react';
import {
  addGnosisChain,
  addWBobToken,
  addWxdaiToken,
  switchToGnosis,
} from '@/lib/onboarding';

type Status = 'idle' | 'pending' | 'done' | 'rejected' | 'no-provider';

function statusLabel(s: Status, doneText: string): string {
  switch (s) {
    case 'pending': return 'Asking wallet…';
    case 'done': return doneText;
    case 'rejected': return 'Wallet declined — try again';
    case 'no-provider': return 'No wallet detected';
    default: return '';
  }
}

export function OnboardingPanel() {
  const [chain, setChain] = useState<Status>('idle');
  const [wbob, setWbob] = useState<Status>('idle');
  const [wxdai, setWxdai] = useState<Status>('idle');

  async function onAddChain() {
    setChain('pending');
    const r = await switchToGnosis();
    setChain(
      r === 'switched' || r === 'added'
        ? 'done'
        : r === 'no-provider'
          ? 'no-provider'
          : 'rejected',
    );
  }

  async function onAddWbob() {
    setWbob('pending');
    const r = await addWBobToken();
    setWbob(r === 'added' ? 'done' : r === 'no-provider' ? 'no-provider' : 'rejected');
  }

  async function onAddWxdai() {
    setWxdai('pending');
    const r = await addWxdaiToken();
    setWxdai(r === 'added' ? 'done' : r === 'no-provider' ? 'no-provider' : 'rejected');
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          One-click setup
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Most n00bs trip on the same three steps. Click these in order and
          your wallet is ready.
        </p>
      </div>

      <ul className="space-y-2">
        <SetupRow
          step="1"
          title="Add Gnosis chain"
          subtitle="Where wBOB lives. Chain ID 100. Native gas = xDAI."
          status={chain}
          doneText="✓ Gnosis selected"
          onClick={onAddChain}
        />
        <SetupRow
          step="2"
          title="Add wBOB token"
          subtitle="So your wallet shows your balance."
          status={wbob}
          doneText="✓ wBOB visible"
          onClick={onAddWbob}
        />
        <SetupRow
          step="3"
          title="Add WXDAI token"
          subtitle="Wrapped X-DAI — what you'll trade a sliver of wBOB for."
          status={wxdai}
          doneText="✓ WXDAI visible"
          onClick={onAddWxdai}
        />
      </ul>
    </div>
  );
}

function SetupRow({
  step,
  title,
  subtitle,
  status,
  doneText,
  onClick,
}: {
  step: string;
  title: string;
  subtitle: string;
  status: Status;
  doneText: string;
  onClick: () => void;
}) {
  const label = statusLabel(status, doneText);
  const done = status === 'done';
  return (
    <li className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-3">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? 'bg-bob-500/30 text-bob-300' : 'bg-bob-500/10 text-bob-400'
        }`}
      >
        {done ? '✓' : step}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-100">{title}</p>
        <p className="text-xs text-gray-500">{subtitle}</p>
        {label && (
          <p
            className={`mt-1 text-xs ${
              status === 'done'
                ? 'text-bob-400'
                : status === 'rejected' || status === 'no-provider'
                  ? 'text-red-400'
                  : 'text-gray-400'
            }`}
          >
            {label}
          </p>
        )}
      </div>
      <button
        onClick={onClick}
        disabled={status === 'pending'}
        className="btn-secondary shrink-0 text-xs px-3 py-1.5"
      >
        {done ? 'Re-add' : 'Add'}
      </button>
    </li>
  );
}
