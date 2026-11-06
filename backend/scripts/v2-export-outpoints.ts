/**
 * Build the V1 → V2 import list: every Dobbscoin outpoint V1 ever minted, as
 * BridgeControllerV2.outpointKey values, cross-checked. READ-ONLY: reads Gnosis,
 * the Dobbscoin node, and the bridge DB (in a READ ONLY transaction). Sends nothing.
 *
 *   cd backend && set -a && . ../.env && set +a && \
 *   node --import=tsx scripts/v2-export-outpoints.ts --from <V1 deploy block> --to <block of Safe tx 1> --out v1-outpoints.json
 *
 * Run it AFTER Safe tx 1 (V1 paused + mintNonce bumped + BRIDGE_EXECUTOR_ROLE
 * revoked) has reached finality, with --to = that tx's block: from there on no
 * V1 mint can exist that is missing from the list. The script refuses to call
 * the list complete unless V1 is paused AND role-less at --to.
 *
 * Checks, any failure → exit 1, final=false, nothing to import:
 *   - --from is at/before V1's deployment (no code at --from - 1)
 *   - logs come from ONE pinned RPC (no fallback mixing) whose head covers latest
 *   - every log's sourceChainId == the configured Dobbscoin chain id
 *   - no outpoint appears twice (that would mean V1 itself minted it twice)
 *   - each outpoint has a source_deposits row whose mint tx hash is this log's tx
 *   - our Dobbscoin node shows the tx with that output, worth >= the minted amount
 *   - EVERY mint_requests row (recorded tx or not) that V1.processedDeposits says
 *     is minted appears among the logs: catches a V1 mint the DB never recorded
 *   - every DB-recorded mint tx that SUCCEEDED appears among the logs (reverted /
 *     missing recorded txs are noted, not counted as mints)
 *   - sum of V1 MintExecuted amounts == sum of wBOB minted (Transfer from 0x0)
 *   - no inbound order is still in flight
 * The import list = V1-minted outpoints + EVERY other deposit recorded before the
 * cutover (fully refunded ones never touched the chain). --allow <file> takes a
 * reviewed { "<txid>:<vout>": "reason" } list; allowed items are reported.
 * final additionally requires: --to <= the 'finalized' block, V1 paused and
 * role-less at --to AND at latest, and no V1 MintExecuted in (--to, latest].
 * Output: { ..., count, keys, batches } with batches of BATCH keys for
 * importProcessedOutpoints (each ~20k gas/key; 300 keys ≈ 6M gas). After the
 * import, run scripts/v2-verify-import.ts against the same file BEFORE sealImport
 * and again before the final unpause.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createPublicClient, http, parseAbi, parseAbiItem, keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import { loadConfig } from '../src/config.js';
import { DobbscoinBackendRpc, RpcCallError } from '../src/dobbscoin/rpc.js';
import { outpointKey } from '../src/executor/mint-executor.js';

// ~20k gas per new key: 300 keys ≈ 6M gas, well under Gnosis's ~17M block limit.
const BATCH = 300;
const MINT_EXECUTED = parseAbiItem(
  'event MintExecuted(bytes32 indexed depositId, address indexed recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout)',
);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ZERO = zeroAddress;
const V1_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function wBOB() view returns (address)',
]);
const WBOB_ABI = parseAbi(['function hasRole(bytes32, address) view returns (bool)']);

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
}

async function main(): Promise<void> {
  const from = BigInt(arg('from'));
  const to = BigInt(arg('to'));
  const out = arg('out');
  // Required, never inferred: after the .env flip BRIDGE_CONTROLLER_ADDRESS is V2.
  const v1 = arg('v1') as Hex;
  const config = loadConfig();
  if (v1.toLowerCase() === config.bridgeControllerAddress.toLowerCase() && config.bridgeControllerVersion === 2) {
    throw new Error('--v1 is the configured V2 controller');
  }
  // ONE transport for everything chain-side: a fallback could answer getLogs
  // from a lagging node with [] and silently drop mints.
  const rpcUrl = process.argv.includes('--rpc') ? arg('rpc') : config.gnosisRpcUrls[0]!;
  const client = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
  const rpc = new DobbscoinBackendRpc(config.dobbscoinRpc);
  const problems: string[] = [];
  const notes: string[] = [];

  // ── Is the list allowed to be final? ──
  const wbob = await client.readContract({ address: v1, abi: V1_ABI, functionName: 'wBOB' }) as Hex;
  const pausedAtTo = await client.readContract({ address: v1, abi: V1_ABI, functionName: 'paused', blockNumber: to }) as boolean;
  const roleAtTo = await client.readContract({
    address: wbob, abi: WBOB_ABI, functionName: 'hasRole',
    args: [keccak256(toBytes('BRIDGE_EXECUTOR_ROLE')), v1], blockNumber: to,
  }) as boolean;
  if (!pausedAtTo || roleAtTo) {
    problems.push(`V1 at block ${to}: paused=${pausedAtTo}, BRIDGE_EXECUTOR_ROLE=${roleAtTo}. ` +
      `Run Safe tx 1 first and pass its block as --to; otherwise V1 can still mint after this list.`);
  }
  const latest = await client.getBlockNumber();
  const finalized = (await client.getBlock({ blockTag: 'finalized' })).number!;
  if (to > finalized) problems.push(`--to ${to} is not finalized yet (finalized: ${finalized}); wait and rerun`);
  const pausedNow = await client.readContract({ address: v1, abi: V1_ABI, functionName: 'paused' }) as boolean;
  const roleNow = await client.readContract({
    address: wbob, abi: WBOB_ABI, functionName: 'hasRole', args: [keccak256(toBytes('BRIDGE_EXECUTOR_ROLE')), v1],
  }) as boolean;
  if (!pausedNow || roleNow) problems.push(`V1 NOW (block ${latest}): paused=${pausedNow}, role=${roleNow} — it could mint again`);
  if (from > 0n) {
    const codeBefore = await client.getCode({ address: v1, blockNumber: from - 1n });
    if (codeBefore && codeBefore !== '0x') problems.push(`--from ${from} is after V1's deployment: earlier mints would be missed`);
  }

  // ── All V1 MintExecuted logs in [from, to] ──
  const chunk = BigInt(config.gnosisLogScanChunk);
  const logs: Array<{ txHash: Hex; block: bigint; amount: bigint; chainId: bigint; sourceTxHash: Hex; vout: number }> = [];
  for (let s = from; s <= to; s += chunk) {
    const e = s + chunk - 1n < to ? s + chunk - 1n : to;
    for (const l of await client.getLogs({ address: v1, event: MINT_EXECUTED, fromBlock: s, toBlock: e })) {
      const a = l.args as { amount: bigint; sourceChainId: bigint; sourceTxHash: Hex; sourceVout: number };
      logs.push({ txHash: l.transactionHash!, block: l.blockNumber!, amount: a.amount, chainId: a.sourceChainId,
                  sourceTxHash: a.sourceTxHash, vout: Number(a.sourceVout) });
    }
    if (((s - from) / chunk) % 500n === 0n) process.stderr.write(`  scanned to block ${e}, ${logs.length} mints\n`);
  }

  // ── No V1 mint may exist after --to ──
  for (let s2 = to + 1n; s2 <= latest; s2 += chunk) {
    const e2 = s2 + chunk - 1n < latest ? s2 + chunk - 1n : latest;
    const late = await client.getLogs({ address: v1, event: MINT_EXECUTED, fromBlock: s2, toBlock: e2 });
    for (const l of late) problems.push(`V1 MintExecuted AFTER --to at block ${l.blockNumber} (tx ${l.transactionHash})`);
  }

  // ── Reviewed allow-list (optional): { "<txid>:<vout>": "reason", ... } ──
  // For genuine one-off edge cases ONLY (e.g. a node that no longer knows an
  // ancient tx). Every allowed item is printed and written to the output.
  const allow: Record<string, string> = process.argv.includes('--allow')
    ? JSON.parse(readFileSync(arg('allow'), 'utf8')) : {};
  const allowed: string[] = [];
  const problem = (op: string | null, msg: string) => {
    if (op !== null && allow[op]) allowed.push(`${msg}  [ALLOWED: ${allow[op]}]`);
    else problems.push(msg);
  };

  // ── DB view (read only) ──
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  const [allRows, deposits] = await sql.begin('read only', async (tx) => [
    await tx<{ txid: string; vout: number; gnosis_tx_hash: string | null; deposit_id: string }[]>`
      SELECT sd.txid, sd.vout, mr.gnosis_tx_hash, encode(mr.deposit_id, 'hex') AS deposit_id
      FROM mint_requests mr JOIN source_deposits sd ON sd.order_id = mr.order_id
    `,
    await tx<{ txid: string; vout: number; state: string; order_id: string; created_at: Date; has_refund: boolean }[]>`
      SELECT sd.txid, sd.vout, bo.state, bo.id::text AS order_id, bo.created_at,
             EXISTS (SELECT 1 FROM deposit_refunds r WHERE r.order_id = bo.id) AS has_refund
      FROM source_deposits sd JOIN bridge_orders bo ON bo.id = sd.order_id
      WHERE bo.order_type = 'inbound' AND sd.txid IS NOT NULL AND sd.vout IS NOT NULL
    `,
  ] as const);
  await sql.end();
  const opOf = (txid: string, vout: number) => `${txid.replace(/^0x/, '').toLowerCase()}:${vout}`;
  const keyOf = (txid: string, vout: number) => outpointKey(config.dobbscoinChainId, (`0x${txid.replace(/^0x/, '')}`) as Hex, vout);

  // A recorded mint tx that reverted or never landed is NOT a mint (e.g. an
  // in-flight V1 executeMint that Safe tx 1 reverted). Check receipts so such
  // rows don't block the export forever; processedDeposits below still decides.
  const PROCESSED_ABI = parseAbi(['function processedDeposits(bytes32) view returns (bool)']);
  const dbRows: typeof allRows[number][] = [];
  for (const r of allRows) {
    if (r.gnosis_tx_hash === null) continue;
    const rc = await client.getTransactionReceipt({ hash: r.gnosis_tx_hash as Hex }).catch(() => null);
    if (rc && rc.status === 'success') dbRows.push(r);
    else notes.push(`${opOf(r.txid, r.vout)}: recorded mint tx ${r.gnosis_tx_hash} ${rc ? 'REVERTED' : 'not found'}; not counted as a mint`);
  }
  const dbByOutpoint = new Map(dbRows.map((r) => [opOf(r.txid, r.vout), r]));

  // ── Per-log checks ──
  const keys: Hex[] = [];
  const seen = new Set<string>();
  const logTxHashes = new Set<string>();
  for (const l of logs) {
    const txidPlain = l.sourceTxHash.replace(/^0x/, '').toLowerCase();
    const op = `${txidPlain}:${l.vout}`;
    logTxHashes.add(l.txHash.toLowerCase());
    if (l.chainId !== config.dobbscoinChainId) {
      problem(op, `${op}: sourceChainId ${l.chainId} != ${config.dobbscoinChainId}`);
      // V2 pins SOURCE_CHAIN_ID: if this is allowed through, block the output
      // under the canonical chain id too, or it stays mintable on V2.
      const canonical = keyOf(txidPlain, l.vout);
      if (!seen.has(canonical)) { seen.add(canonical); keys.push(canonical); }
    }
    const key = outpointKey(l.chainId, l.sourceTxHash, l.vout);
    if (seen.has(key)) { problems.push(`${op}: MINTED TWICE by V1 (duplicate outpoint)`); continue; }
    seen.add(key);
    keys.push(key);

    const db = dbByOutpoint.get(op);
    if (!db) problem(op, `${op}: no source_deposits/mint_requests row with a successful mint tx`);
    else if (db.gnosis_tx_hash!.toLowerCase() !== l.txHash.toLowerCase()) {
      problem(op, `${op}: DB mint tx ${db.gnosis_tx_hash} != log tx ${l.txHash}`);
    }
    try {
      const t = await rpc.getRawTransactionVerbose(txidPlain);
      const o = t.vout.find((v) => v.n === l.vout);
      const sat = o ? BigInt(Math.round(o.value * 1e8)) : -1n;
      if (!o) problem(op, `${op}: node has the tx but no output ${l.vout}`);
      else if (sat < l.amount) problem(op, `${op}: output is ${sat} sat < minted ${l.amount}`);
    } catch (err) {
      problem(op, `${op}: node lookup failed: ${err instanceof RpcCallError ? err.message : String(err)}`);
    }
  }
  for (const r of dbRows) {
    if (!logTxHashes.has(r.gnosis_tx_hash!.toLowerCase())) {
      problem(opOf(r.txid, r.vout), `DB mint ${r.txid}:${r.vout} (tx ${r.gnosis_tx_hash}) has no V1 MintExecuted in [${from}, ${to}]`);
    }
  }
  // Every row V1 itself says is minted — INCLUDING rows whose mint tx the DB
  // never recorded — must be in the list, or V2 could mint that output again.
  for (const r of allRows) {
    const minted = await client.readContract({
      address: v1, abi: PROCESSED_ABI, functionName: 'processedDeposits', args: [`0x${r.deposit_id}` as Hex], blockNumber: to,
    }) as boolean;
    const op = opOf(r.txid, r.vout);
    if (minted && !seen.has(keyOf(r.txid, r.vout))) problem(op, `${op}: V1.processedDeposits=true but NOT in the logs (unrecorded mint?)`);
    if (!minted && dbByOutpoint.has(op)) problem(op, `${op}: DB has a successful mint tx but V1.processedDeposits=false`);
  }

  // ── Supply: the V1 logs must account for EVERY wBOB minted in the range ──
  // (catches a log provider silently dropping a MintExecuted the DB never knew).
  let tokenMinted = 0n;
  for (let s3 = from; s3 <= to; s3 += chunk) {
    const e3 = s3 + chunk - 1n < to ? s3 + chunk - 1n : to;
    for (const t of await client.getLogs({ address: wbob, event: TRANSFER, args: { from: ZERO }, fromBlock: s3, toBlock: e3 })) {
      tokenMinted += (t.args as { value: bigint }).value;
    }
  }
  const logMinted = logs.reduce((a, l) => a + l.amount, 0n);
  if (tokenMinted !== logMinted) {
    problems.push(`wBOB minted in [${from}, ${to}] is ${tokenMinted} but V1 MintExecuted sum is ${logMinted}: some mint is missing from the logs`);
  }

  // ── Settled pre-cutover deposits are blocked too ──
  // Refunds before the cutover never touched the chain, so a fully refunded
  // deposit is not in the V1 logs. Import every deposit that is SETTLED
  // (COMPLETED, REFUNDED, or with a deposit_refunds row); an extra key can only
  // block a mint. A FAILED order without a refund is not settled (FAILED →
  // REFUNDED is still possible) and is left to V2. Orders created after --to
  // arrived when V1 could no longer mint: they belong to V2, not in-flight.
  const toTime = (await client.getBlock({ blockNumber: to })).timestamp;
  let settledAdded = 0;
  const inFlight: string[] = [];
  const leftToV2: string[] = [];
  for (const d of deposits) {
    const createdAfterTo = BigInt(Math.floor(d.created_at.getTime() / 1000)) > toTime;
    const settled = d.state === 'COMPLETED' || d.state === 'REFUNDED' || d.has_refund;
    if (!settled) {
      if (createdAfterTo || d.state === 'FAILED') leftToV2.push(`${d.order_id} (${d.state})`);
      else inFlight.push(`${d.order_id} (${d.state})`);
      continue;
    }
    const k = keyOf(d.txid, d.vout);
    if (!seen.has(k)) { seen.add(k); keys.push(k); settledAdded++; }
  }
  if (inFlight.length > 0) {
    problems.push(`${inFlight.length} inbound order(s) created before --to are still in flight — drain them first: ${inFlight.slice(0, 5).join(', ')}`);
  }
  if (leftToV2.length > 0) notes.push(`${leftToV2.length} unsettled order(s) left to V2 (not imported): ${leftToV2.slice(0, 5).join(', ')}`);

  const batches: Hex[][] = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));
  const final = problems.length === 0;
  writeFileSync(out, JSON.stringify({
    v1, wbob, rpcUrl, fromBlock: from.toString(), toBlock: to.toString(), finalizedBlock: finalized.toString(),
    latestBlock: latest.toString(), final,
    count: keys.length, v1MintCount: logs.length, settledDepositsAdded: settledAdded,
    dbMintCount: dbRows.length, dbRowsChecked: allRows.length,
    tokenMinted: tokenMinted.toString(), logMinted: logMinted.toString(),
    problems, allowed, notes,
    // Never hand out import batches from a list that is not final.
    keys: final ? keys : [], batches: final ? batches : [],
  }, null, 2));
  console.log(`V1 mints: ${logs.length}, + settled deposits: ${settledAdded}, keys: ${keys.length}, DB mints: ${dbRows.length}, ` +
    `wBOB minted ${tokenMinted} vs logs ${logMinted}, batches: ${batches.length}, final: ${final}, ` +
    `problems: ${problems.length}, allowed: ${allowed.length} → ${out}`);
  for (const p of problems.slice(0, 30)) console.log(`  PROBLEM ${p}`);
  for (const a of allowed) console.log(`  ALLOWED ${a}`);
  for (const n of notes.slice(0, 10)) console.log(`  note    ${n}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
