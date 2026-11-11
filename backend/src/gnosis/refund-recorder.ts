/**
 * Records refunds on BridgeControllerV2 (recordRefund, REFUND_MARKER_ROLE) so the
 * contract itself enforces, per Dobbscoin output, minted + refunded <= value.
 *
 * Why (2026-11 review round 3): refunds lived only in Postgres. A DB writer
 * could mint wBOB against a deposit the bridge had already refunded in full, or
 * raise a split mint to the whole deposit while the excess was still refunded.
 *
 * The refund executor records a refund as soon as the bridge decides that part
 * of a deposit will not be minted, and never broadcasts a refund until this
 * reports it recorded. recordRefund is monotonic and idempotent on-chain, and
 * can only BLOCK mints, so the relayer key holding the role is low-risk.
 * Reads and the write are pinned to the primary (our node).
 */
import {
  createPublicClient, createWalletClient, http, parseAbi,
  keccak256, encodeAbiParameters, parseAbiParameters, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';
import { withRelayerLock } from './relayer-lock.js';

const ABI = parseAbi([
  'function recordRefund(bytes32 sourceTxHash, uint32 sourceVout, uint256 value, uint256 refundedTotal)',
  'function refundedAmount(bytes32) view returns (uint256)',
  'function outpointValue(bytes32) view returns (uint256)',
  'function mintedAmount(bytes32) view returns (uint256)',
  'function processedOutpoints(bytes32) view returns (bool)',
]);

export interface RefundRecord {
  depositTxid: string;          // Dobbscoin txid, display hex, with or without 0x
  depositVout: number;
  depositValueSat: bigint;      // the whole output
  refundedTotalSat: bigint;     // the part the bridge will not mint (excess_sat)
}

export class RefundRecorder {
  private readonly reader;
  private readonly writer;
  private readonly account;
  /** outpoint key → recorded total we have already seen on-chain (avoids re-reading). */
  private readonly seen = new Map<string, bigint>();
  /** outpoint key → recordRefund tx sent and not yet mined (never send a second one). */
  private readonly pending = new Map<string, { hash: Hex; sentAt: number; alerted: boolean }>();
  /** Called once when a recordRefund tx has been pending this long (default 10 min). */
  stuckAfterMs = 10 * 60_000;
  onStuck: ((key: Hex, hash: Hex, ageMs: number) => void) | null = null;

  constructor(private readonly config: BackendConfig) {
    this.account = privateKeyToAccount(config.executorPrivateKey as Hex);
    // Security reads (is it recorded? imported? minted?) gate sending coins:
    // only our node answers them, never a public fallback (review round 7 #5).
    this.reader = createPublicClient({ chain: gnosis, transport: http(config.gnosisRpcUrl) });
    this.writer = createWalletClient({ account: this.account, chain: gnosis, transport: http(config.gnosisRpcUrl) });
  }

  private txHash(txid: string): Hex {
    return (txid.startsWith('0x') ? txid : `0x${txid}`) as Hex;
  }

  key(r: RefundRecord): Hex {
    return keccak256(encodeAbiParameters(parseAbiParameters('uint256, bytes32, uint32'),
      [this.config.dobbscoinChainId, this.txHash(r.depositTxid), r.depositVout]));
  }

  /**
   * True if V2 already holds at least this refund for this output. fresh=true
   * always reads the chain (the broadcast gate: the Safe may have LOWERED it with
   * resetOutpointRecord since we cached it, review round 6 #6).
   */
  async isRecorded(r: RefundRecord, fresh = false): Promise<boolean> {
    const k = this.key(r);
    if (!fresh && (this.seen.get(k) ?? -1n) >= r.refundedTotalSat) return true;
    const onChain = await this.reader.readContract({
      address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'refundedAmount', args: [k],
    }) as bigint;
    this.seen.set(k, onChain);
    return onChain >= r.refundedTotalSat;
  }

  /** What V2 minted for this output (0 if none, or if it was only imported from V1). */
  async mintedAmount(r: RefundRecord): Promise<bigint> {
    return await this.reader.readContract({
      address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'mintedAmount', args: [this.key(r)],
    }) as bigint;
  }

  /** Imported from V1 (processed, nothing minted on V2): V2 refuses refunds for these. */
  async isImported(r: RefundRecord): Promise<boolean> {
    const k = this.key(r);
    const [processed, minted] = await Promise.all([
      this.reader.readContract({ address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'processedOutpoints', args: [k] }),
      this.reader.readContract({ address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'mintedAmount', args: [k] }),
    ]) as [boolean, bigint];
    return processed && minted === 0n;
  }

  /**
   * Record it if needed. NEVER blocks on mining: sends at most one tx per
   * output, returns false while it is pending, true once V2 shows the record.
   * Throws if the tx reverted. A tx pending past stuckAfterMs is reported once
   * (onStuck) and still not resent: a resend would only queue behind it.
   */
  async ensureRecorded(r: RefundRecord): Promise<boolean> {
    const k = this.key(r);
    const p = this.pending.get(k);
    if (p) {
      const rc = await this.reader.getTransactionReceipt({ hash: p.hash }).catch(() => null);
      if (rc === null) {
        const age = Date.now() - p.sentAt;
        if (age > this.stuckAfterMs && !p.alerted) { p.alerted = true; this.onStuck?.(k, p.hash, age); }
        return false;
      }
      this.pending.delete(k);
      this.seen.delete(k);
      if (rc.status !== 'success') throw new Error(`recordRefund reverted (${p.hash})`);
      return this.isRecorded(r);
    }
    if (await this.isRecorded(r)) return true;
    const hash = await withRelayerLock(() => this.writer.writeContract({
      address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'recordRefund',
      args: [this.txHash(r.depositTxid), r.depositVout, r.depositValueSat, r.refundedTotalSat],
    }));
    this.pending.set(k, { hash, sentAt: Date.now(), alerted: false });
    return false;
  }
}
