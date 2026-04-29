'use client';

import Link from 'next/link';
import { CowSwapWidget } from '@/components/CowSwapWidget';
import { OkuSwapWidget } from '@/components/OkuSwapWidget';
import { NFADisclaimer } from '@/components/NFADisclaimer';

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
          <li>• Verify the token addresses in your wallet before signing — wBOB is <code className="text-bob-300">0x13550ae6…488263</code>; WXDAI is <code className="text-bob-300">0xe91D153E…3a97d</code>.</li>
          <li>• Both venues need xDAI for gas. If you have none, check the gas-drip status on the home page or use the public Gnosis faucet.</li>
          <li>• (BOB) is not for sale — it is for trade.</li>
        </ul>
        <NFADisclaimer compact />
      </div>
    </div>
  );
}
