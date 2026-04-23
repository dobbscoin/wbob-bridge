import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center gap-12 py-8">
      {/* Hero */}
      <div className="text-center space-y-4 max-w-2xl">
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="text-bob-400">wBOB</span> Bridge
        </h1>
        <p className="text-lg text-gray-400">
          Move Dobbscoin between the Dobbscoin network and Gnosis chain.
          Lock BOB to receive wrapped wBOB — or burn wBOB to redeem BOB.
        </p>
      </div>

      {/* Flow cards */}
      <div className="grid sm:grid-cols-2 gap-6 w-full max-w-2xl">
        <Link href="/deposit" className="card group hover:border-bob-600 transition-colors">
          <div className="flex items-start justify-between mb-4">
            <div className="rounded-lg bg-bob-500/10 p-2.5">
              <ArrowDownIcon className="h-6 w-6 text-bob-400" />
            </div>
            <span className="text-xs font-medium text-gray-500 group-hover:text-bob-400 transition-colors">
              Dobbscoin → Gnosis →
            </span>
          </div>
          <h2 className="text-lg font-semibold mb-1">Deposit BOB</h2>
          <p className="text-sm text-gray-400">
            Send BOB to a bridge address. Receive wBOB on Gnosis after
            6 Dobbscoin confirmations.
          </p>
          <ul className="mt-4 space-y-1 text-xs text-gray-500">
            <li>✓ Non-custodial — you control the Gnosis address</li>
            <li>✓ No approval required</li>
            <li>✓ Typically 10–30 minutes</li>
          </ul>
        </Link>

        <Link href="/withdraw" className="card group hover:border-bob-600 transition-colors">
          <div className="flex items-start justify-between mb-4">
            <div className="rounded-lg bg-bob-500/10 p-2.5">
              <ArrowUpIcon className="h-6 w-6 text-bob-400" />
            </div>
            <span className="text-xs font-medium text-gray-500 group-hover:text-bob-400 transition-colors">
              Gnosis → Dobbscoin →
            </span>
          </div>
          <h2 className="text-lg font-semibold mb-1">Withdraw BOB</h2>
          <p className="text-sm text-gray-400">
            Burn wBOB on Gnosis. Receive BOB at your Dobbscoin address
            within a few minutes.
          </p>
          <ul className="mt-4 space-y-1 text-xs text-gray-500">
            <li>✓ Connect your Gnosis wallet</li>
            <li>✓ One transaction — burn + payout in one flow</li>
            <li>✓ Typically 5–15 minutes</li>
          </ul>
        </Link>
      </div>

      {/* How it works */}
      <div className="w-full max-w-2xl card space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          How it works
        </h3>
        <div className="grid sm:grid-cols-3 gap-4 text-sm">
          <Step n="1" title="Connect wallet" text="For withdrawals, connect your Gnosis wallet (MetaMask or WalletConnect)." />
          <Step n="2" title="Initiate bridge" text="For deposits, get a Dobbscoin address and send BOB. For withdrawals, confirm in your wallet." />
          <Step n="3" title="Receive funds" text="wBOB arrives on Gnosis after confirmation, or BOB arrives on Dobbscoin after payout." />
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bob-500/20 text-xs font-bold text-bob-400">
          {n}
        </span>
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-gray-400 text-xs pl-8">{text}</p>
    </div>
  );
}

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12m4.5-4.5V21" />
    </svg>
  );
}
