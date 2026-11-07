/**
 * Read back a V1 → V2 import: every key from a FINAL v2-export-outpoints.ts file
 * must read processedOutpoints(key) == true on V2. READ-ONLY; sends nothing.
 *
 *   cd backend && set -a && . ../.env && set +a && \
 *   node --import=tsx scripts/v2-verify-import.ts --stage pre-seal    --file v1-outpoints.json --v2 <V2> [--rpc <url>]
 *   node --import=tsx scripts/v2-verify-import.ts --stage pre-unpause --file v1-outpoints.json --v2 <V2> \
 *        --relayer <backend relayer address> --module <EmergencyPauseModule> --old-module <V1 module> \
 *        --signers <watcher addr,addr,...> --mint-limit <sat per 24h> [--payout-min <sat>] [--rpc <url>]
 *
 * Both stages: every key imported; V1 paused and role-less; V2 HOLDS
 * BRIDGE_EXECUTOR_ROLE (else every mint/withdrawal reverts); V2 still PAUSED
 * (unpausing before the backend scans V2 loses V2 burns for good).
 * pre-unpause also: importSealed; the relayer holds REFUND_MARKER_ROLE (else
 * refunds are never recorded, so never sent); the new module is enabled on the
 * Safe and the old one is not; the module operator is not the relayer; V2's
 * signer set is exactly --signers (and reaches THRESHOLD), its rolling limit is
 * --mint-limit, its minWithdrawal >= the backend payout minimum.
 * Both stages also: the RPC is Gnosis (chain 100, as when exported) and V2's
 * SOURCE_CHAIN_ID is the chain id the export's keys were built with.
 * Exit 1 on any problem.
 * (V2 accepts imports after the seal too, so a gap found here can still be
 * closed; but never unpause with one open.)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, parseAbiItem, keccak256, toBytes, type Hex } from 'viem';
import { gnosis } from 'viem/chains';

const V2_ABI = parseAbi([
  'function processedOutpoints(bytes32) view returns (bool)',
  'function importSealed() view returns (bool)',
  'function paused() view returns (bool)',
  'function wBOB() view returns (address)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function SOURCE_CHAIN_ID() view returns (uint256)',
  'function THRESHOLD() view returns (uint8)',
  'function signerCount() view returns (uint8)',
  'function isSigner(address) view returns (bool)',
  'function mintLimitPerWindow() view returns (uint256)',
  'function minWithdrawal() view returns (uint256)',
]);
const MODULE_ABI = parseAbi(['function safe() view returns (address)', 'function operator() view returns (address)']);
const MINT_EXECUTED = parseAbiItem(
  'event MintExecuted(bytes32 indexed depositId, address indexed recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout)',
);
const SAFE_ABI = parseAbi(['function isModuleEnabled(address) view returns (bool)']);
const V1_ABI = parseAbi(['function paused() view returns (bool)']);
const WBOB_ABI = parseAbi(['function hasRole(bytes32, address) view returns (bool)']);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const file = JSON.parse(readFileSync(arg('file'), 'utf8')) as
    { final: boolean; keys: Hex[]; v1: Hex; count: number; toBlock: string; wbob: Hex;
      sourceChainId?: string; gnosisChainId?: number };
  const v2 = arg('v2') as Hex;
  const stage = arg('stage');
  if (stage !== 'pre-seal' && stage !== 'pre-unpause') throw new Error('--stage must be pre-seal or pre-unpause');
  const rpc = arg('rpc', (process.env['GNOSIS_RPC_URLS'] ?? process.env['GNOSIS_RPC_URL'] ?? '').split(',')[0]);
  const client = createPublicClient({ chain: gnosis, transport: http(rpc) });
  const problems: string[] = [];

  if (!file.final) problems.push('export file is not final: do not import from it');

  // The right chain, and keys built for the chain id V2 pins.
  const chainId = await client.getChainId();
  if (chainId !== 100) problems.push(`RPC ${rpc} is chain ${chainId}, not Gnosis (100): a rehearsal fork?`);
  if (file.gnosisChainId !== undefined && file.gnosisChainId !== chainId) {
    problems.push(`export was made on chain ${file.gnosisChainId}, this RPC is chain ${chainId}`);
  }
  const srcChain = await client.readContract({ address: v2, abi: V2_ABI, functionName: 'SOURCE_CHAIN_ID' }) as bigint;
  if (file.sourceChainId === undefined) problems.push('export file has no sourceChainId (re-export with the current script)');
  else if (BigInt(file.sourceChainId) !== srcChain) {
    problems.push(`V2 SOURCE_CHAIN_ID is ${srcChain} but the export's keys were built for ${file.sourceChainId}: none would block anything`);
  }
  if (file.keys.length !== file.count) problems.push(`file lists ${file.keys.length} keys but count=${file.count}`);

  const wbob = await client.readContract({ address: v2, abi: V2_ABI, functionName: 'wBOB' }) as Hex;
  const role = keccak256(toBytes('BRIDGE_EXECUTOR_ROLE'));
  const [sealed, paused, v1Paused, v1Role, v2Role] = await Promise.all([
    client.readContract({ address: v2, abi: V2_ABI, functionName: 'importSealed' }),
    client.readContract({ address: v2, abi: V2_ABI, functionName: 'paused' }),
    client.readContract({ address: file.v1, abi: V1_ABI, functionName: 'paused' }),
    client.readContract({ address: wbob, abi: WBOB_ABI, functionName: 'hasRole', args: [role, file.v1] }),
    client.readContract({ address: wbob, abi: WBOB_ABI, functionName: 'hasRole', args: [role, v2] }),
  ]) as [boolean, boolean, boolean, boolean, boolean];
  if (!v1Paused || v1Role) problems.push(`V1 ${file.v1}: paused=${v1Paused}, BRIDGE_EXECUTOR_ROLE=${v1Role} (must be paused, role-less)`);

  // Don't trust the file's "final" flag alone: re-check, on THIS rpc, that the
  // export was made for this token and that V1 could not mint after its --to
  // (catches an old export, or one made on a rehearsal fork).
  if (!file.wbob || file.wbob.toLowerCase() !== wbob.toLowerCase()) {
    problems.push(`export was made for wBOB ${file.wbob}, but this V2 mints ${wbob}`);
  }
  const toBlock = BigInt(file.toBlock ?? '0');
  if (toBlock === 0n) problems.push('export file has no toBlock');
  else {
    const [pausedAtTo, roleAtTo] = await Promise.all([
      client.readContract({ address: file.v1, abi: V1_ABI, functionName: 'paused', blockNumber: toBlock }),
      client.readContract({ address: wbob, abi: WBOB_ABI, functionName: 'hasRole', args: [role, file.v1], blockNumber: toBlock }),
    ]) as [boolean, boolean];
    if (!pausedAtTo || roleAtTo) problems.push(`at the export's toBlock ${toBlock} V1 was paused=${pausedAtTo}, role=${roleAtTo}: the export is not final`);
    const latest = await client.getBlockNumber();
    for (let s = toBlock + 1n; s <= latest; s += 1000n) {
      const e = s + 999n < latest ? s + 999n : latest;
      for (const l of await client.getLogs({ address: file.v1, event: MINT_EXECUTED, fromBlock: s, toBlock: e })) {
        problems.push(`V1 minted AFTER the export's toBlock (block ${l.blockNumber}, tx ${l.transactionHash}): re-export`);
      }
    }
  }
  if (!v2Role) problems.push(`V2 does NOT hold BRIDGE_EXECUTOR_ROLE on wBOB: every mint and withdrawal would revert`);
  if (!paused) problems.push(`V2 is already UNPAUSED: unpause only as the very last step, after the backend scans V2 (else V2 burns are lost)`);

  if (stage === 'pre-unpause') {
    if (!sealed) problems.push('importSealed=false: sealImport has not run');
    const relayer = arg('relayer') as Hex;
    const marker = await client.readContract({
      address: v2, abi: V2_ABI, functionName: 'hasRole', args: [keccak256(toBytes('REFUND_MARKER_ROLE')), relayer],
    }) as boolean;
    if (!marker) problems.push(`relayer ${relayer} lacks REFUND_MARKER_ROLE: refunds could never be recorded, so never sent`);
    const mod = arg('module') as Hex;
    const oldMod = arg('old-module') as Hex;
    const safe = await client.readContract({ address: mod, abi: MODULE_ABI, functionName: 'safe' }) as Hex;
    const [newOn, oldOn] = await Promise.all([
      client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [mod] }),
      client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [oldMod] }),
    ]) as [boolean, boolean];
    if (!newOn) problems.push(`EmergencyPauseModule ${mod} is NOT enabled on Safe ${safe}`);
    if (oldOn) problems.push(`old module ${oldMod} is STILL enabled on Safe ${safe} (it can unpause V1's controller)`);
    const op = await client.readContract({ address: mod, abi: MODULE_ABI, functionName: 'operator' }) as Hex;
    if (op.toLowerCase() === relayer.toLowerCase()) {
      problems.push(`the emergency module's operator is the relayer ${relayer}: a stolen relayer key could freeze the token. Set a separate operator.`);
    }

    // Deploy parameters: a mistake here stalls the bridge without reverting anything.
    const signers = arg('signers').split(',').map((a) => a.trim()).filter(Boolean) as Hex[];
    const [threshold, count, limit, minW] = await Promise.all([
      client.readContract({ address: v2, abi: V2_ABI, functionName: 'THRESHOLD' }),
      client.readContract({ address: v2, abi: V2_ABI, functionName: 'signerCount' }),
      client.readContract({ address: v2, abi: V2_ABI, functionName: 'mintLimitPerWindow' }),
      client.readContract({ address: v2, abi: V2_ABI, functionName: 'minWithdrawal' }),
    ]) as [number, number, bigint, bigint];
    for (const sg of signers) {
      const on = await client.readContract({ address: v2, abi: V2_ABI, functionName: 'isSigner', args: [sg] }) as boolean;
      if (!on) problems.push(`watcher ${sg} is NOT a V2 signer: its signatures will not count`);
    }
    if (count !== signers.length) problems.push(`V2 has ${count} signers but --signers lists ${signers.length}: an unknown key can sign`);
    if (signers.length < threshold) problems.push(`only ${signers.length} watcher signer(s) for THRESHOLD ${threshold}: nothing can ever mint`);
    const wantLimit = BigInt(arg('mint-limit'));
    if (limit !== wantLimit) problems.push(`V2 mintLimitPerWindow is ${limit}, expected ${wantLimit} (units are sat per 24h)`);
    const payoutMin = BigInt(arg('payout-min', process.env['PAYOUT_MIN_SAT'] ?? '100000'));
    if (minW < payoutMin) problems.push(`V2 minWithdrawal ${minW} is under the backend payout minimum ${payoutMin}: such burns can't be paid`);
  }

  let missing = 0;
  for (const k of file.keys) {
    const ok = await client.readContract({ address: v2, abi: V2_ABI, functionName: 'processedOutpoints', args: [k] }) as boolean;
    if (!ok) { missing++; if (missing <= 20) problems.push(`NOT imported: ${k}`); }
  }
  if (missing > 20) problems.push(`... ${missing - 20} more keys not imported`);

  console.log(`V2 ${v2}: ${file.keys.length - missing}/${file.keys.length} keys imported, importSealed=${sealed}, ` +
    `paused=${paused}, V2 has BRIDGE_EXECUTOR_ROLE=${v2Role}`);
  if (missing === 0 && problems.length === 0) {
    console.log(stage === 'pre-unpause'
      ? 'OK (pre-unpause): imported, sealed, roles and modules right, still paused. Unpause once the services point at V2.'
      : 'OK (pre-seal): every key imported, roles right, still paused. Safe to call sealImport.');
  }
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
