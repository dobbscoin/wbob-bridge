/**
 * Proof of reserves: server-side reader.
 *
 * Two numbers, each read from its own chain:
 *   wBOB supply  = WBob.totalSupply() on Gnosis, via public RPC.
 *   (BOB) held   = sum of explorer.dobbscoin.info balances over the bridge's
 *                  Dobbscoin addresses.
 *
 * The address LIST comes from the bridge database (read only). The BALANCES do
 * not: they come from the explorer, which indexes the chain, so the DB cannot
 * vouch for its own coins. If the DB forgets an address, reserves read LOW,
 * never high, which is the safe direction for this page to be wrong in.
 *
 * Which addresses (see backend/src/wallet/hd-wallet.ts, tx-builder.ts and
 * executor/payout-executor.ts): every bridge coin sits on an HD-derived P2PKH
 * address, deposits on m/0/N and payout change on m/1/N. We watch
 *   - every deposit address ever handed out (users can resend to them), and
 *   - every change address that still holds, or recently held, a bridge UTXO.
 * "Recently" covers the gap between a payout broadcast (DB marks the inputs
 * spent at once) and its first confirmation (when the explorer sees the change).
 *
 * Server only. Never import this from a client component.
 */
import postgres from 'postgres';
import { createPublicClient, fallback, http, parseAbi } from 'viem';
import { gnosis } from 'viem/chains';

const SAT = 100_000_000n;
const CACHE_MS = 60_000;
/** A side that failed may show its last good reading this long, marked stale. */
const STALE_LIMIT_MS = 15 * 60_000;

export const EXPLORER_URL =
  process.env.RESERVES_EXPLORER_URL ?? 'https://explorer.dobbscoin.info';
export const WBOB_CONTRACT =
  (process.env.NEXT_PUBLIC_WBOB_ADDRESS ||
    '0x13550ae65f22A36f60A50d625B70b58666488263') as `0x${string}`;
const GNOSIS_RPCS = (process.env.RESERVES_GNOSIS_RPC_URLS ??
  'https://rpc.gnosischain.com,https://gnosis-rpc.publicnode.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ERC20 = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export interface BobAddressBalance { address: string; balance: string }

export interface ReservesReport {
  /** (BOB) held at the bridge's addresses, 8-decimal string. null if unreadable. */
  bobReserve: string | null;
  /** wBOB totalSupply on Gnosis, decimal string. null if unreadable. */
  wbobSupply: string | null;
  /** bobReserve / wbobSupply, rounded DOWN to 6 places. null if either side is missing. */
  ratio: string | null;
  /** Watched addresses with their explorer balance, largest first. */
  bobAddresses: BobAddressBalance[];
  wbobContract: string;
  /** Explorer tip height when the (BOB) side was read. */
  bobHeight: number | null;
  /** Gnosis block the supply was read at. */
  gnosisBlock: string | null;
  /** When this report was assembled (ISO). */
  checkedAt: string;
  /** When each side was last read successfully (ISO). */
  bobCheckedAt: string | null;
  gnosisCheckedAt: string | null;
  /** true when a side failed this round and its last good reading is shown instead. */
  stale: { bob: boolean; gnosis: boolean };
  /** Present only when a side could not be read this round. */
  errors?: { bob?: string; gnosis?: string };
  sources: {
    bobBalances: string;
    bobHeight: string;
    bobAddressList: string;
    wbobSupply: string;
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtUnits(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0');
  return decimals ? `${whole}.${frac}` : `${whole}`;
}

/** Parse the explorer's decimal balance text ("42.6", "2156.23591163") to satoshis. */
function parseBobToSat(text: string): bigint {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`unexpected balance "${t.slice(0, 60)}"`);
  const [w, f = ''] = t.split('.');
  if (f.length > 8) throw new Error(`more than 8 decimals in "${t}"`);
  return BigInt(w!) * SAT + BigInt(f.padEnd(8, '0'));
}

async function fetchText(url: string, timeoutMs = 8_000): Promise<string> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

// ─── address list (bridge DB, read only) ────────────────────────────────────

let sqlClient: ReturnType<typeof postgres> | null = null;
function db() {
  const url = process.env.RESERVES_DATABASE_URL;
  if (!url) throw new Error('RESERVES_DATABASE_URL is not set');
  sqlClient ??= postgres(url, { max: 1, idle_timeout: 30, connect_timeout: 5 });
  return sqlClient;
}

async function readAddressList(): Promise<string[]> {
  const rows = await db()<{ address: string }[]>`
    SELECT dobbscoin_address AS address FROM deposit_addresses
    UNION
    SELECT address FROM bridge_utxos WHERE derivation_path = 'deposit'
    UNION
    SELECT address FROM bridge_utxos
     WHERE derivation_path = 'change'
       AND (status IN ('available', 'reserved') OR updated_at > now() - interval '24 hours')
  `;
  return rows.map((r) => r.address).sort();
}

// ─── (BOB) side ─────────────────────────────────────────────────────────────

async function addressBalanceSat(addr: string): Promise<bigint> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = await fetchText(`${EXPLORER_URL}/ext/getbalance/${addr}`);
      // eIquidus answers {"error":"address not found."} for an address with no history.
      if (body.includes('address not found')) return 0n;
      return parseBobToSat(body);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${addr}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

interface BobSide { reserveSat: bigint; addresses: BobAddressBalance[]; height: number; at: string }

async function readBobSide(): Promise<BobSide> {
  const addrs = await readAddressList();
  if (addrs.length === 0) throw new Error('bridge address list is empty');
  const heightText = await fetchText(`${EXPLORER_URL}/api/getblockcount`);
  const height = Number(heightText.trim());
  if (!Number.isInteger(height) || height <= 0) throw new Error('explorer block height unreadable');

  // Four at a time: this runs at most once a minute, and the explorer is ours to be polite to.
  const out: { address: string; sat: bigint }[] = [];
  for (let i = 0; i < addrs.length; i += 4) {
    const batch = addrs.slice(i, i + 4);
    const sats = await Promise.all(batch.map(addressBalanceSat));
    batch.forEach((address, j) => out.push({ address, sat: sats[j]! }));
  }
  out.sort((a, b) => (a.sat === b.sat ? a.address.localeCompare(b.address) : a.sat > b.sat ? -1 : 1));
  return {
    reserveSat: out.reduce((s, r) => s + r.sat, 0n),
    addresses: out.map((r) => ({ address: r.address, balance: fmtUnits(r.sat, 8) })),
    height,
    at: new Date().toISOString(),
  };
}

// ─── Gnosis side ────────────────────────────────────────────────────────────

const gnosisClient = createPublicClient({
  chain: gnosis,
  transport: fallback(GNOSIS_RPCS.map((u) => http(u, { timeout: 8_000 }))),
});

interface GnosisSide { supply: bigint; decimals: number; block: bigint; at: string }

async function readGnosisSide(): Promise<GnosisSide> {
  const block = await gnosisClient.getBlockNumber();
  const [supply, decimals] = await Promise.all([
    gnosisClient.readContract({ address: WBOB_CONTRACT, abi: ERC20, functionName: 'totalSupply', blockNumber: block }),
    gnosisClient.readContract({ address: WBOB_CONTRACT, abi: ERC20, functionName: 'decimals', blockNumber: block }),
  ]);
  return { supply, decimals: Number(decimals), block, at: new Date().toISOString() };
}

// ─── assemble + cache ───────────────────────────────────────────────────────

let lastBob: BobSide | null = null;
let lastGnosis: GnosisSide | null = null;
let cached: { at: number; report: ReservesReport } | null = null;
let inflight: Promise<ReservesReport> | null = null;

function usable<T extends { at: string }>(v: T | null): T | null {
  return v && Date.now() - Date.parse(v.at) <= STALE_LIMIT_MS ? v : null;
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

async function build(): Promise<ReservesReport> {
  const [bobRes, gnoRes] = await Promise.allSettled([readBobSide(), readGnosisSide()]);
  const errors: { bob?: string; gnosis?: string } = {};

  if (bobRes.status === 'fulfilled') lastBob = bobRes.value;
  else { errors.bob = short(bobRes.reason); console.error('[reserves] (BOB) side failed:', bobRes.reason); }
  if (gnoRes.status === 'fulfilled') lastGnosis = gnoRes.value;
  else { errors.gnosis = short(gnoRes.reason); console.error('[reserves] Gnosis side failed:', gnoRes.reason); }

  const bob = bobRes.status === 'fulfilled' ? bobRes.value : usable(lastBob);
  const gno = gnoRes.status === 'fulfilled' ? gnoRes.value : usable(lastGnosis);

  // Compare in the smaller unit. wBOB has 8 decimals, like (BOB), but read it rather than assume it.
  let ratio: string | null = null;
  if (bob && gno && gno.supply > 0n) {
    const supplySat = gno.decimals >= 8
      ? gno.supply / 10n ** BigInt(gno.decimals - 8)
      : gno.supply * 10n ** BigInt(8 - gno.decimals);
    // Integer division rounds DOWN, so the ratio is never shown higher than it is.
    const scaled = (bob.reserveSat * 1_000_000n) / supplySat;
    ratio = fmtUnits(scaled, 6);
  }

  const report: ReservesReport = {
    bobReserve: bob ? fmtUnits(bob.reserveSat, 8) : null,
    wbobSupply: gno ? fmtUnits(gno.supply, gno.decimals) : null,
    ratio,
    bobAddresses: bob?.addresses ?? [],
    wbobContract: WBOB_CONTRACT,
    bobHeight: bob?.height ?? null,
    gnosisBlock: gno ? gno.block.toString() : null,
    checkedAt: new Date().toISOString(),
    bobCheckedAt: bob?.at ?? null,
    gnosisCheckedAt: gno?.at ?? null,
    stale: {
      bob: bobRes.status !== 'fulfilled' && bob !== null,
      gnosis: gnoRes.status !== 'fulfilled' && gno !== null,
    },
    sources: {
      bobBalances: `${EXPLORER_URL}/ext/getbalance/<address>`,
      bobHeight: `${EXPLORER_URL}/api/getblockcount`,
      bobAddressList: 'bridge database: deposit addresses, plus change addresses holding bridge coins',
      wbobSupply: `totalSupply() on ${WBOB_CONTRACT}, Gnosis chain 100, via ${GNOSIS_RPCS.map((u) => new URL(u).host).join(' / ')}`,
    },
  };
  if (errors.bob || errors.gnosis) report.errors = errors;
  return report;
}

export async function getReserves(): Promise<ReservesReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  // One refresh at a time: concurrent page views share it instead of each hitting the RPCs.
  inflight ??= build()
    .then((report) => { cached = { at: Date.now(), report }; return report; })
    .finally(() => { inflight = null; });
  return inflight;
}
