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
 * Checks, any failure → exit 1 and nothing to import:
 *   - every log's sourceChainId == the configured Dobbscoin chain id
 *   - no outpoint appears twice (that would mean V1 itself minted it twice)
 *   - each outpoint has a source_deposits row whose mint tx hash is this log's tx
 *   - our Dobbscoin node shows the tx with that output, worth >= the minted amount
 *   - every DB mint (mint_requests.gnosis_tx_hash set) appears among the logs
 * Output: { ..., count, keys, batches } with batches of BATCH keys for
 * importProcessedOutpoints (each ~20k gas/key; 500 keys ≈ 10M gas).
 */
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { createPublicClient, http, fallback, parseAbi, parseAbiItem, keccak256, toBytes, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import { loadConfig } from '../src/config.js';
import { DobbscoinBackendRpc, RpcCallError } from '../src/dobbscoin/rpc.js';
import { outpointKey } from '../src/executor/mint-executor.js';

const BATCH = 500;
const MINT_EXECUTED = parseAbiItem(
  'event MintExecuted(bytes32 indexed depositId, address indexed recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout)',
);
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
  const v1 = (process.argv.includes('--v1') ? arg('v1') : process.env['V1_BRIDGE_CONTROLLER_ADDRESS']
    ?? process.env['BRIDGE_CONTROLLER_ADDRESS']) as Hex;
  if (!v1) throw new Error('V1 address: pass --v1 or set V1_BRIDGE_CONTROLLER_ADDRESS');
  const config = loadConfig();
  const client = createPublicClient({ chain: gnosis, transport: fallback(config.gnosisRpcUrls.map((u) => http(u))) });
  const rpc = new DobbscoinBackendRpc(config.dobbscoinRpc);
  const problems: string[] = [];

  // ── Is the list allowed to be final? ──
  const wbob = await client.readContract({ address: v1, abi: V1_ABI, functionName: 'wBOB' }) as Hex;
  const pausedAtTo = await client.readContract({ address: v1, abi: V1_ABI, functionName: 'paused', blockNumber: to }) as boolean;
  const roleAtTo = await client.readContract({
    address: wbob, abi: WBOB_ABI, functionName: 'hasRole',
    args: [keccak256(toBytes('BRIDGE_EXECUTOR_ROLE')), v1], blockNumber: to,
  }) as boolean;
  const final = pausedAtTo && !roleAtTo;
  if (!final) {
    problems.push(`V1 at block ${to}: paused=${pausedAtTo}, BRIDGE_EXECUTOR_ROLE=${roleAtTo}. ` +
      `Run Safe tx 1 first and pass its block as --to; otherwise V1 can still mint after this list.`);
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

  // ── DB view (read only) ──
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  const dbRows = await sql.begin('read only', (tx) => tx<{ txid: string; vout: number; gnosis_tx_hash: string | null }[]>`
    SELECT sd.txid, sd.vout, mr.gnosis_tx_hash
    FROM mint_requests mr JOIN source_deposits sd ON sd.order_id = mr.order_id
    WHERE mr.gnosis_tx_hash IS NOT NULL
  `);
  await sql.end();
  const dbByOutpoint = new Map(dbRows.map((r) => [`${r.txid.replace(/^0x/, '').toLowerCase()}:${r.vout}`, r]));

  // ── Per-log checks ──
  const keys: Hex[] = [];
  const seen = new Set<string>();
  const logTxHashes = new Set<string>();
  for (const l of logs) {
    const txidPlain = l.sourceTxHash.replace(/^0x/, '').toLowerCase();
    const op = `${txidPlain}:${l.vout}`;
    logTxHashes.add(l.txHash.toLowerCase());
    if (l.chainId !== config.dobbscoinChainId) problems.push(`${op}: sourceChainId ${l.chainId} != ${config.dobbscoinChainId}`);
    const key = outpointKey(l.chainId, l.sourceTxHash, l.vout);
    if (seen.has(key)) { problems.push(`${op}: MINTED TWICE by V1 (duplicate outpoint)`); continue; }
    seen.add(key);
    keys.push(key);

    const db = dbByOutpoint.get(op);
    if (!db) problems.push(`${op}: no source_deposits/mint_requests row with a mint tx`);
    else if (db.gnosis_tx_hash!.toLowerCase() !== l.txHash.toLowerCase()) {
      problems.push(`${op}: DB mint tx ${db.gnosis_tx_hash} != log tx ${l.txHash}`);
    }
    try {
      const t = await rpc.getRawTransactionVerbose(txidPlain);
      const o = t.vout.find((v) => v.n === l.vout);
      const sat = o ? BigInt(Math.round(o.value * 1e8)) : -1n;
      if (!o) problems.push(`${op}: node has the tx but no output ${l.vout}`);
      else if (sat < l.amount) problems.push(`${op}: output is ${sat} sat < minted ${l.amount}`);
    } catch (err) {
      problems.push(`${op}: node lookup failed: ${err instanceof RpcCallError ? err.message : String(err)}`);
    }
  }
  for (const r of dbRows) {
    if (!logTxHashes.has(r.gnosis_tx_hash!.toLowerCase())) {
      problems.push(`DB mint ${r.txid}:${r.vout} (tx ${r.gnosis_tx_hash}) has no V1 MintExecuted in [${from}, ${to}]`);
    }
  }

  const batches: Hex[][] = [];
  for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));
  writeFileSync(out, JSON.stringify({
    v1, wbob, fromBlock: from.toString(), toBlock: to.toString(), final,
    count: keys.length, dbMintCount: dbRows.length, problems, keys, batches,
  }, null, 2));
  console.log(`V1 mints: ${logs.length}, unique outpoints: ${keys.length}, DB mints: ${dbRows.length}, ` +
    `batches: ${batches.length}, final: ${final}, problems: ${problems.length} → ${out}`);
  for (const p of problems.slice(0, 30)) console.log(`  PROBLEM ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
