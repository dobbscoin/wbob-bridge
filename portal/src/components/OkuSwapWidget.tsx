'use client';

import { WBOB_ADDRESS } from '@/lib/contracts';
import { WXDAI_ADDRESS } from '@/lib/onboarding';

/**
 * Oku.trade swap embed — Gnosis chain, default direction WXDAI → wBOB
 * (the "trade IN to wBOB" direction; complements the CoW Swap widget which
 * defaults to wBOB → WXDAI).
 */
export function OkuSwapWidget() {
  const inToken = WXDAI_ADDRESS;
  const outToken = WBOB_ADDRESS || '';
  const src = `https://oku.trade/swap?inputChain=gnosis&inToken=${inToken}&outToken=${outToken}`;

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

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-black">
        <iframe
          src={src}
          title="Oku — WXDAI to wBOB"
          className="h-[640px] w-full"
          allow="clipboard-read; clipboard-write; web3"
        />
      </div>

      <p className="text-[11px] text-gray-500">
        Routed by{' '}
        <a
          href={src}
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
