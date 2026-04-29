'use client';

import { WBOB_ADDRESS } from '@/lib/contracts';
import { WXDAI_ADDRESS } from '@/lib/onboarding';

/**
 * Embeds CoW Swap targeting Gnosis chain (chainId 100) with sell=wBOB,
 * buy=WXDAI. Liquidity routes through whatever AMMs CoW finds; we don't
 * run the swap ourselves.
 */
export function CowSwapWidget() {
  const sell = WBOB_ADDRESS || 'wBOB';
  const buy = WXDAI_ADDRESS;
  const src = `https://swap.cow.fi/#/100/swap/${sell}/${buy}?widget=true`;

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Trade wBOB → WXDAI
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Peel off enough wBOB for gas. Gnosis fees are dust — even a few BOB
          will fuel thousands of transactions. Trade what feels fair.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-black">
        <iframe
          src={src}
          title="CoW Swap — wBOB to WXDAI"
          className="h-[640px] w-full"
          allow="clipboard-read; clipboard-write; web3"
        />
      </div>

      <p className="text-[11px] text-gray-500">
        Swap is routed by{' '}
        <a
          href="https://swap.cow.fi/#/100/swap/wBOB/WXDAI"
          target="_blank"
          rel="noopener noreferrer"
          className="text-bob-400 hover:underline"
        >
          CoW Swap
        </a>{' '}
        on Gnosis. The bridge does not custody, route, or take a fee on this
        trade. Verify the token addresses in your wallet before signing.
      </p>
    </div>
  );
}
