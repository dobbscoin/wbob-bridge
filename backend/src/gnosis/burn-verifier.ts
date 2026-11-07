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
}

type Receipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: { address: string; topics: Hex[]; data: Hex }[];
};
export interface BurnChainReader {
  getTransactionReceipt(a: { hash: Hex }): Promise<Receipt>;
  getBlockNumber(): Promise<bigint>;
}

export class BurnVerifier implements BurnVerifierLike {
  private readonly client: BurnChainReader;
  private readonly controllers: Set<string>;

  constructor(private readonly config: BackendConfig, client?: BurnChainReader) {
    this.client = client ?? (createPublicClient({ chain: gnosis, transport: http(config.gnosisRpcUrl) }) as unknown as BurnChainReader);
    // V2 cutover: burns on the previous controller(s) are still real burns.
    this.controllers = new Set([config.bridgeControllerAddress, ...(config.legacyBridgeControllerAddresses ?? [])]
      .map((a) => a.toLowerCase()));
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
      // "not found" from a healthy node means there is no such tx on our chain.
      if (/could not be found|not found/i.test(msg) && !/fetch|timeout|ECONN|network/i.test(msg)) {
        return no(`burn tx ${c.burnTxHash} does not exist on Gnosis`);
      }
      return { ok: false, defer: true, reason: `Gnosis node unreachable for burn check: ${msg.slice(0, 160)}` };
    }

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
    return { ok: true };
  }
}
