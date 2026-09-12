'use client';

import Link from 'next/link';
import { CowSwapWidget } from '@/components/CowSwapWidget';
import { OkuSwapWidget } from '@/components/OkuSwapWidget';
import { NFADisclaimer } from '@/components/NFADisclaimer';
import { EmptyMarketNotice } from '@/components/EmptyMarketNotice';
import { CopyAddress } from '@/components/CopyAddress';
import { WBOB_ADDRESS } from '@/lib/contracts';
import { WXDAI_ADDRESS } from '@/lib/onboarding';

export default function TradePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-bob-700/40 bg-bob-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-bob-300">
          Trade
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          Trade wBOB on Gnosis
        </h1>
        <p className="text-sm text-gray-400">
          Two embedded venues, both on Gnosis chain. CoW Swap defaults to
          wBOB → WXDAI; Oku defaults to WXDAI → wBOB. The bridge takes no fee
          on either. Routes and pricing are entirely the venue&rsquo;s.
        </p>
        <p className="text-xs text-gray-500">
          ←{' '}
          <Link href="/" className="text-bob-400 hover:underline">
            Back to Bridge &amp; Fuel
          </Link>
        </p>
      </div>

      <EmptyMarketNotice />

      <NFADisclaimer />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <CowSwapWidget />
        <OkuSwapWidget />
      </div>

      <div className="card space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          What this page is
        </h3>
        <ul className="text-xs text-gray-500 space-y-1">
          <li>• Two third-party swap UIs, embedded as iframes. Bridge takes no fee.</li>
          <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>• Verify the token addresses in your wallet before signing —</span>
            <span className="inline-flex items-center gap-1">
              wBOB <CopyAddress address={WBOB_ADDRESS} label="wBOB token address" />
            </span>
            <span className="inline-flex items-center gap-1">
              WXDAI <CopyAddress address={WXDAI_ADDRESS} label="WXDAI token address" />
            </span>
          </li>
          <li>• Both venues need xDAI for gas. If you have none, check the gas-drip status on the home page or use the public Gnosis faucet.</li>
          <li>• (BOB) is not for sale — it is for trade.</li>
        </ul>
        <NFADisclaimer compact />
      </div>
    </div>
  );
}
