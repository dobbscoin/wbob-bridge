/**
 * Burn verifier (2026-11-06, review round 5 #1).
 *
 * The payout executor used to pay bridge_orders.user_dobbscoin_address /
 * amount_sat straight from Postgres. Anyone able to write the DB could queue a
 * payout for a burn that never happened, or redirect / enlarge a real one, and
 * the bridge would pay (BOB) for wBOB nobody burned.
 *
 * Now, right before a payout is SIGNED, the burn is re-read from Gnosis on the
 * pinned primary RPC (our own node, never the public fallbacks, so a lying
 * public endpoint can't vouch for a fake burn):
 *   - the burn tx receipt exists and succeeded,
 *   - it holds exactly one WithdrawalRequested log FROM the bridge controller
 *     with this withdrawalId,
 *   - sender, amount and destination (as the ingest step sanitizes it) equal
 *     what is about to be paid,
 *   - it is at least GNOSIS_CONFIRMATION_DEPTH blocks deep.
 * A mismatch is an attack or corruption: the order is parked with a critical
 * alert. An unreachable node or a too-shallow burn only DEFERS (retried next
 * poll); nothing is paid without a positive answer.
 */
import { createPublicClient, http, parseAbiItem, decodeEventLog, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';
import { sanitizeDobbscoinDestination } from './destination.js';

const WITHDRAWAL_EVENT = parseAbiItem(
  'event WithdrawalRequested(uint256 indexed withdrawalId, address indexed sender, uint256 amount, string dobbscoinAddress, uint256 nonce)',
);

export interface BurnClaim {
  withdrawalId: string;           // uint256 as decimal string (withdrawal_requests.withdrawal_id)
  burnTxHash: string | null;
  burnBlockNumber?: bigint | null; // withdrawal_requests.burn_block_number (where ingest saw it)
  senderAddress: string;          // withdrawal_requests.sender_address
  amountSat: bigint;              // what will be paid (bridge_orders.amount_sat)
  dobbscoinAddress: string;       // where it will be paid (bridge_orders.user_dobbscoin_address)
}

export type BurnVerdict =
  | { ok: true }
  | { ok: false; defer: true; reason: string }     // try again later; not evidence of anything
  | { ok: false; defer: false; reason: string };   // does not match the chain: never pay automatically

export interface BurnVerifierLike {
  verify(c: BurnClaim): Promise<BurnVerdict>;
  /** What a finalized burn asked for; null = node can't say now; string = no such burn. */
  readBurn?(withdrawalId: string, burnTxHash: string): Promise<{ amount: bigint; dest: string } | null | string>;
}

type Receipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: { address: string; topics: Hex[]; data: Hex }[];
};
export interface BurnChainReader {
  getTransactionReceipt(a: { hash: Hex }): Promise<Receipt>;
  getBlockNumber(): Promise<bigint>;
  getBlock(a: { blockTag: 'finalized' }): Promise<{ number: bigint | null }>;
}

export class BurnVerifier implements BurnVerifierLike {
  private readonly client: BurnChainReader;
  private readonly controllers: Set<string>;
  /** withdrawalId -> first time our caught-up node said "no such receipt". */
  private readonly notFoundSince = new Map<string, number>();
  /** "Does not exist" only after the node, caught up past the burn, says so for this long. */
  notFoundGraceMs = 10 * 60_000;

  constructor(private readonly config: BackendConfig, client?: BurnChainReader) {
    this.client = client ?? (createPublicClient({ chain: gnosis, transport: http(config.gnosisRpcUrl) }) as unknown as BurnChainReader);
    // V2 cutover: burns on the previous controller(s) are still real burns.
    this.controllers = new Set([config.bridgeControllerAddress, ...(config.legacyBridgeControllerAddresses ?? [])]
      .map((a) => a.toLowerCase()));
  }

  /**
   * (review round 12) What a burn actually asked for, read from our node:
   * the one WithdrawalRequested log of the bridge for this withdrawalId in this
   * tx, finalized. null = the node can't say right now; a string = it doesn't exist.
   */
  async readBurn(withdrawalId: string, burnTxHash: string): Promise<{ amount: bigint; dest: string } | null | string> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) return 'not a tx hash';
    let rc: Receipt;
    let fin: bigint | null;
    try {
      rc = await this.client.getTransactionReceipt({ hash: burnTxHash as Hex });
      fin = (await this.client.getBlock({ blockTag: 'finalized' })).number;
    } catch (err) {
      return (err as Error)?.name === 'TransactionReceiptNotFoundError' ? 'no such receipt on our node' : null;
    }
    if (fin === null || rc.blockNumber > fin) return null;
    if (rc.status !== 'success') return 'burn tx reverted';
    const found: { amount: bigint; dest: string }[] = [];
    for (const log of rc.logs) {
      if (!this.controllers.has(log.address.toLowerCase())) continue;
      try {
        const ev = decodeEventLog({ abi: [WITHDRAWAL_EVENT], topics: log.topics as [Hex, ...Hex[]], data: log.data });
        const a = ev.args as { withdrawalId: bigint; amount: bigint; dobbscoinAddress: string };
        if (a.withdrawalId.toString() === withdrawalId) found.push({ amount: a.amount, dest: a.dobbscoinAddress });
      } catch { /* not ours */ }
    }
    return found.length === 1 ? found[0]! : `${found.length} matching WithdrawalRequested logs`;
  }

  async verify(c: BurnClaim): Promise<BurnVerdict> {
    const no = (reason: string): BurnVerdict => ({ ok: false, defer: false, reason: `burn check failed: ${reason}` });
    if (!c.burnTxHash || !/^0x[0-9a-fA-F]{64}$/.test(c.burnTxHash)) return no(`no valid burn tx hash (${c.burnTxHash ?? 'null'})`);

    let rc: Receipt;
    let tip: bigint;
    try {
      [rc, tip] = await Promise.all([
        this.client.getTransactionReceipt({ hash: c.burnTxHash as Hex }),
        this.client.getBlockNumber(),
      ]);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // (review round 11; ported from the V2 branch's round-6 fix) Only viem's
      // own "receipt not found" is evidence, and only from a node past the
      // burn's block, repeatedly: a lagging/resyncing node or a proxy 404 defers.
      if ((err as Error)?.name !== 'TransactionReceiptNotFoundError') {
        return { ok: false, defer: true, reason: `Gnosis node unreachable for burn check: ${msg.slice(0, 160)}` };
      }
      let tipNow: bigint;
      try { tipNow = await this.client.getBlockNumber(); }
      catch { return { ok: false, defer: true, reason: 'Gnosis node unreachable for burn check' }; }
      const need = (c.burnBlockNumber ?? 0n) + BigInt(this.config.gnosisConfirmationDepth);
      if (c.burnBlockNumber == null || tipNow < need) {
        return { ok: false, defer: true, reason: `our Gnosis node (at ${tipNow}) has no receipt for ${c.burnTxHash} yet; waiting until it is past ${need}` };
      }
      const first = this.notFoundSince.get(c.withdrawalId) ?? Date.now();
      this.notFoundSince.set(c.withdrawalId, first);
      if (Date.now() - first < this.notFoundGraceMs) {
        return { ok: false, defer: true, reason: `our Gnosis node has no receipt for ${c.burnTxHash}; re-checking before refusing` };
      }
      return no(`burn tx ${c.burnTxHash} does not exist on our Gnosis node (caught up to ${tipNow}, still missing after ${Math.round((Date.now() - first) / 60_000)} min)`);
    }
    this.notFoundSince.delete(c.withdrawalId);

    if (rc.status !== 'success') return no(`burn tx ${c.burnTxHash} reverted`);

    const matches: { sender: string; amount: bigint; dest: string }[] = [];
    for (const log of rc.logs) {
      if (!this.controllers.has(log.address.toLowerCase())) continue;
      let ev;
      try {
        ev = decodeEventLog({ abi: [WITHDRAWAL_EVENT], topics: log.topics as [Hex, ...Hex[]], data: log.data });
      } catch { continue; }
      const a = ev.args as { withdrawalId: bigint; sender: string; amount: bigint; dobbscoinAddress: string };
      if (a.withdrawalId.toString() !== c.withdrawalId) continue;
      matches.push({ sender: a.sender, amount: a.amount, dest: sanitizeDobbscoinDestination(a.dobbscoinAddress).value });
    }
    if (matches.length !== 1) {
      return no(`burn tx ${c.burnTxHash} has ${matches.length} WithdrawalRequested log(s) from the bridge for withdrawalId ${c.withdrawalId}`);
    }
    const m = matches[0]!;
    if (m.sender.toLowerCase() !== c.senderAddress.toLowerCase()) return no(`sender on-chain ${m.sender} != recorded ${c.senderAddress}`);
    if (m.amount !== c.amountSat) return no(`amount on-chain ${m.amount} != payout amount ${c.amountSat}`);
    if (m.dest !== c.dobbscoinAddress) return no(`destination on-chain ${m.dest} != payout address ${c.dobbscoinAddress}`);

    const depth = tip - rc.blockNumber + 1n;
    if (depth < BigInt(this.config.gnosisConfirmationDepth)) {
      return { ok: false, defer: true, reason: `burn only ${depth} block(s) deep (need ${this.config.gnosisConfirmationDepth})` };
    }
    // (review round 11) and finalized: a reorg can no longer remove it.
    let fin: bigint | null;
    try { fin = (await this.client.getBlock({ blockTag: 'finalized' })).number; }
    catch { return { ok: false, defer: true, reason: 'Gnosis node unreachable for the finalized block' }; }
    if (fin === null || rc.blockNumber > fin) {
      return { ok: false, defer: true, reason: `burn block ${rc.blockNumber} is not finalized yet (finalized: ${fin ?? '?'})` };
    }
    return { ok: true };
  }
}
