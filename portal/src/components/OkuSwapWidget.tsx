'use client';

import { WBOB_ADDRESS } from '@/lib/contracts';
import { WXDAI_ADDRESS } from '@/lib/onboarding';

/**
 * Oku.trade launcher (NOT an iframe — Oku's CSP `frame-ancestors` only
 * allows 'self' + blockscout + walletconnect, so embedding from
 * bridge.subgenius.finance is blocked at the browser level).
 *
 * Renders a launcher card matching the visual weight of the CoW Swap
 * iframe next to it. Clicking opens Oku in a new tab with the right
 * tokens preselected on Gnosis.
 */
export function OkuSwapWidget() {
  const inToken = WXDAI_ADDRESS;
  const outToken = WBOB_ADDRESS || '';
  const href = `https://oku.trade/swap?inputChain=gnosis&inToken=${inToken}&outToken=${outToken}`;

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Trade WXDAI → wBOB · via Oku
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          The other direction. Trade WXDAI back into wBOB through Oku&rsquo;s
          aggregated routes on Gnosis.
        </p>
      </div>

      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-[640px] flex-col items-center justify-center rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 to-black px-6 text-center hover:border-bob-600 transition-colors"
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-bob-500/10 ring-1 ring-bob-700/40 group-hover:bg-bob-500/20 transition-colors">
          <svg
            className="h-7 w-7 text-bob-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.8}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-7.5 1.5L21 3m0 0h-5.25M21 3v5.25"
            />
          </svg>
        </div>
        <p className="text-sm font-semibold text-gray-100 group-hover:text-bob-300 transition-colors">
          Open Oku.trade
        </p>
        <p className="mt-1 text-xs text-gray-500">
          WXDAI → wBOB · Gnosis chain · in a new tab
        </p>
        <p className="mt-6 max-w-xs text-[11px] leading-relaxed text-gray-500">
          Oku doesn&rsquo;t allow embedding for security reasons (anti-clickjacking
          policy). The bridge can&rsquo;t inline their UI, but the link is
          pre-filled with the right tokens on Gnosis chain.
        </p>
      </a>

      <p className="text-[11px] text-gray-500">
        Routed by{' '}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-bob-400 hover:underline"
        >
          Oku.trade
        </a>{' '}
        on Gnosis. The bridge does not custody, route, or take a fee on this
        trade. Verify token addresses in your wallet before signing.
      </p>
    </div>
  );
}
