'use client';

import { WBOB_ADDRESS } from '@/lib/contracts';
import { WXDAI_ADDRESS } from '@/lib/onboarding';

/**
 * Oku.trade launcher (NOT an iframe — Oku's CSP `frame-ancestors` only
 * allows 'self' + blockscout + walletconnect, so embedding from
 * bridge.subgenius.finance is blocked at the browser level).
 *
 * Renders a screenshot of Oku's swap box, sized to the CoW Swap iframe
 * next to it. Clicking opens Oku in a new tab with the right tokens
 * preselected on Gnosis.
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
        title="Open Oku.trade in a new tab"
        className="block overflow-hidden rounded-xl border border-gray-800 hover:border-bob-600 transition-colors"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/oku-trade.png"
          alt="Oku swap box: sell WXDAI, buy wBOB. Click to open Oku.trade."
          width={589}
          height={698}
          className="block w-full h-auto lg:h-[640px] lg:object-cover lg:object-left-top"
        />
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
        on Gnosis, in a new tab (Oku doesn&rsquo;t allow embedding). The bridge does not custody or route this trade. The pool it
        trades against is ours, and its 1% fee comes to us. Verify token addresses in your wallet before signing.
      </p>
    </div>
  );
}
