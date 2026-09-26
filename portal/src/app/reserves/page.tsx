import type { Metadata } from 'next';
import Link from 'next/link';
import { getReserves, EXPLORER_URL, WBOB_CONTRACT } from '@/lib/reserves';
import { fmtBob, fmtRatio } from '@/lib/reserves-client';
import { NFADisclaimer } from '@/components/NFADisclaimer';

// Rendered per request from the 60 s cache in lib/reserves, never at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Proof of reserves · wBOB Bridge',
  description: 'wBOB supply on Gnosis next to the (BOB) the bridge holds, read from both chains.',
};

const GNOSISSCAN = 'https://gnosisscan.io';

export default async function ReservesPage() {
  const r = await getReserves();
  const funded = r.bobAddresses.filter((a) => a.balance !== '0.00000000');
  const empty = r.bobAddresses.filter((a) => a.balance === '0.00000000');
  const rpcCall =
    `curl -s https://rpc.gnosischain.com -H 'content-type: application/json' -d ` +
    `'{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"${WBOB_CONTRACT}","data":"0x18160ddd"},"latest"]}'`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-bob-700/40 bg-bob-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-bob-300">
          Reserves
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Proof of reserves</h1>
        <p className="text-sm text-gray-400">
          Every wBOB on Gnosis is meant to have one (BOB) behind it, held by the
          bridge on the Dobbscoin chain. This page reads both chains and puts
          the two numbers side by side. The reading is at most one minute old.
        </p>
        <p className="text-xs text-gray-500">
          ←{' '}
          <Link href="/" className="text-bob-400 hover:underline">Back to Bridge &amp; Fuel</Link>
        </p>
      </div>

      {/* ── The reading ─────────────────────────────────────────────────── */}
      <div className="card space-y-4">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Figure
            label="(BOB) held by the bridge"
            value={r.bobReserve !== null ? fmtBob(r.bobReserve, 8) : 'unreadable'}
            note={r.stale.bob ? `stale, last read ${r.bobCheckedAt}` : r.bobHeight !== null ? `Dobbscoin block ${r.bobHeight.toLocaleString('en-US')}` : undefined}
          />
          <Figure
            label="wBOB on Gnosis"
            value={r.wbobSupply !== null ? fmtBob(r.wbobSupply, 8) : 'unreadable'}
            note={r.stale.gnosis ? `stale, last read ${r.gnosisCheckedAt}` : r.gnosisBlock !== null ? `Gnosis block ${Number(r.gnosisBlock).toLocaleString('en-US')}` : undefined}
          />
          <Figure
            label="Backing"
            value={r.ratio !== null ? `${fmtRatio(r.ratio, 6)} to 1` : 'not computed'}
            note="(BOB) held ÷ wBOB supply, rounded down"
            warn={r.ratio !== null && Number(r.ratio) < 1}
          />
        </dl>
        <p className="text-[11px] text-gray-500">
          Checked {new Date(r.checkedAt).toUTCString()}.{' '}
          <a href="/api/reserves" className="text-bob-400 hover:underline">Raw JSON</a>.
        </p>
        {r.errors && (
          <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200/80 space-y-1">
            {r.errors.bob && <p>(BOB) side could not be read this round: {r.errors.bob}</p>}
            {r.errors.gnosis && <p>Gnosis side could not be read this round: {r.errors.gnosis}</p>}
            <p>A side shown as stale is its last good reading, never an estimate.</p>
          </div>
        )}
      </div>

      {/* ── What the numbers are ────────────────────────────────────────── */}
      <Section title="The two numbers">
        <p>
          <strong className="text-gray-200">wBOB on Gnosis</strong> is{' '}
          <code className="text-bob-300">totalSupply()</code> on the wBOB
          contract{' '}
          <a href={`${GNOSISSCAN}/token/${WBOB_CONTRACT}`} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-bob-400 hover:underline">
            {WBOB_CONTRACT}
          </a>
          , read from Gnosis chain. It counts every wBOB that exists, in every
          wallet and every pool. It goes up only when the bridge mints against
          a (BOB) deposit, and down only when someone burns wBOB to withdraw.
        </p>
        <p>
          <strong className="text-gray-200">(BOB) held by the bridge</strong> is
          the sum of the balances of the bridge&rsquo;s Dobbscoin addresses, as
          indexed by{' '}
          <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer" className="text-bob-400 hover:underline">
            explorer.dobbscoin.info
          </a>
          . Each depositor gets a permanent deposit address, and change from
          payouts goes to fresh bridge addresses, so the reserve is spread over
          several addresses. They are all listed below. The list of addresses
          comes from the bridge&rsquo;s records; the balances come from the
          chain. If the list ever missed an address, the reserve would read
          low, not high.
        </p>
      </Section>

      <Section title="Why the ratio sits a little above 1">
        <p>
          The two chains do not move at the same moment. A deposit counts in
          the reserve once it is in a Dobbscoin block, but its wBOB is minted
          only after 60 confirmations. A withdrawal burns wBOB first and pays
          out (BOB) after. In both cases the reserve briefly holds more than
          the supply. (BOB) sent to a bridge address that has not been minted
          also stays in the reserve.
        </p>
        <p>
          It should not sit below 1. A reading below 1 means there is wBOB
          that no (BOB) in these addresses stands behind.
        </p>
      </Section>

      <Section title="Check it yourself">
        <p>You do not need to trust this page. Each side is public.</p>
        <p className="text-gray-300">wBOB supply</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            On Gnosisscan, open the{' '}
            <a href={`${GNOSISSCAN}/token/${WBOB_CONTRACT}#readContract`} target="_blank" rel="noopener noreferrer" className="text-bob-400 hover:underline">
              contract&rsquo;s Read tab
            </a>{' '}
            and query <code className="text-bob-300">totalSupply</code>. wBOB
            has 8 decimals, so divide by 100,000,000.
          </li>
          <li>
            Or ask any Gnosis RPC. The answer is hex, in units of 0.00000001 wBOB:
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-gray-800 px-3 py-2 font-mono text-[11px] text-gray-300">{rpcCall}</pre>
          </li>
        </ul>
        <p className="text-gray-300">(BOB) held</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Open each address below on explorer.dobbscoin.info and add up the
            balances. The same number, as plain text, is at{' '}
            <code className="break-all text-bob-300">{EXPLORER_URL}/ext/getbalance/&lt;address&gt;</code>.
          </li>
          <li>
            Or skip the explorer and use your own node: add each address as
            watch-only with{' '}
            <code className="text-bob-300">dobbscoin-cli importaddress &lt;address&gt; &quot;&quot; true</code>
            , wait for the rescan, then total{' '}
            <code className="text-bob-300">dobbscoin-cli listunspent</code>.
          </li>
        </ul>
      </Section>

      <Section title={`Bridge addresses (${r.bobAddresses.length} watched)`}>
        {r.bobAddresses.length === 0 ? (
          <p>The address list could not be read this round.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
              {funded.map((a) => <AddressRow key={a.address} {...a} />)}
            </ul>
            {empty.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-gray-400 hover:text-gray-200">
                  {empty.length} more watched address{empty.length === 1 ? '' : 'es'} with a zero balance
                </summary>
                <ul className="mt-2 divide-y divide-gray-800 rounded-lg border border-gray-800">
                  {empty.map((a) => <AddressRow key={a.address} {...a} />)}
                </ul>
              </details>
            )}
            <p className="text-[11px] text-gray-500">
              Watched: every deposit address the bridge has handed out, and every
              change address that holds, or in the last 24 hours held, a bridge
              coin.
            </p>
          </>
        )}
      </Section>

      <Section title="Why this, and not a burned LP">
        <p>
          A liquidity lock or a burned LP token says that one pool&rsquo;s
          liquidity cannot be pulled. It says nothing about whether a bridged
          token is backed: a pool can be locked forever while the coins behind
          the token are gone. For a bridged token the question is whether the
          coins on the other chain are still there. That is a balance on a
          public chain, and anyone can read it.
        </p>
        {/* TODO(btcbob): link the minter-key and recovery policy here once it is
            written. Do not describe either on this page until then. */}
      </Section>

      <NFADisclaimer />
    </div>
  );
}

function Figure({ label, value, note, warn = false }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className={`break-words font-mono text-lg ${warn ? 'text-red-400' : 'text-bob-300'}`}>{value}</dd>
      {note && <dd className="mt-0.5 text-[11px] text-gray-500">{note}</dd>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-gray-400">{children}</div>
    </section>
  );
}

function AddressRow({ address, balance }: { address: string; balance: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
      <a
        href={`${EXPLORER_URL}/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 break-all font-mono text-xs text-bob-400 hover:underline"
      >
        {address}
      </a>
      <span className="font-mono text-xs text-gray-300">{fmtBob(balance, 8)}</span>
    </li>
  );
}
