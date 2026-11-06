/**
 * Read back a V1 → V2 import: every key from a FINAL v2-export-outpoints.ts file
 * must read processedOutpoints(key) == true on V2. READ-ONLY; sends nothing.
 *
 *   cd backend && set -a && . ../.env && set +a && \
 *   node --import=tsx scripts/v2-verify-import.ts --file v1-outpoints.json --v2 <V2 address> [--rpc <url>]
 *
 * Run it after the import batches land, BEFORE sealImport, and again before the
 * final unpause (Safe tx 3). Exit 1 on any missing key or unexpected state.
 * (V2 accepts imports after the seal too, so a gap found here can still be
 * closed; but never unpause with one open.)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, keccak256, toBytes, type Hex } from 'viem';
import { gnosis } from 'viem/chains';

const V2_ABI = parseAbi([
  'function processedOutpoints(bytes32) view returns (bool)',
  'function importSealed() view returns (bool)',
  'function paused() view returns (bool)',
  'function wBOB() view returns (address)',
]);
const V1_ABI = parseAbi(['function paused() view returns (bool)']);
const WBOB_ABI = parseAbi(['function hasRole(bytes32, address) view returns (bool)']);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const file = JSON.parse(readFileSync(arg('file'), 'utf8')) as { final: boolean; keys: Hex[]; v1: Hex; count: number };
  const v2 = arg('v2') as Hex;
  const rpc = arg('rpc', (process.env['GNOSIS_RPC_URLS'] ?? process.env['GNOSIS_RPC_URL'] ?? '').split(',')[0]);
  const client = createPublicClient({ chain: gnosis, transport: http(rpc) });
  const problems: string[] = [];

  if (!file.final) problems.push('export file is not final: do not import from it');
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

  let missing = 0;
  for (const k of file.keys) {
    const ok = await client.readContract({ address: v2, abi: V2_ABI, functionName: 'processedOutpoints', args: [k] }) as boolean;
    if (!ok) { missing++; if (missing <= 20) problems.push(`NOT imported: ${k}`); }
  }
  if (missing > 20) problems.push(`... ${missing - 20} more keys not imported`);

  console.log(`V2 ${v2}: ${file.keys.length - missing}/${file.keys.length} keys imported, importSealed=${sealed}, ` +
    `paused=${paused}, V2 has BRIDGE_EXECUTOR_ROLE=${v2Role}`);
  if (missing === 0 && problems.length === 0) {
    console.log(sealed ? 'OK: complete and sealed. Safe to proceed to the final unpause once the services point at V2.'
                       : 'OK: complete. Safe to call sealImport.');
  }
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
