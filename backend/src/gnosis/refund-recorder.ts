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
 * Reads go through the fallback RPC list; the write is pinned to the primary.
 */
import {
  createPublicClient, createWalletClient, http, fallback, parseAbi,
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

  constructor(private readonly config: BackendConfig) {
    this.account = privateKeyToAccount(config.executorPrivateKey as Hex);
    this.reader = createPublicClient({ chain: gnosis, transport: fallback(config.gnosisRpcUrls.map((u) => http(u))) });
    this.writer = createWalletClient({ account: this.account, chain: gnosis, transport: http(config.gnosisRpcUrl) });
  }

  private txHash(txid: string): Hex {
    return (txid.startsWith('0x') ? txid : `0x${txid}`) as Hex;
  }

  key(r: RefundRecord): Hex {
    return keccak256(encodeAbiParameters(parseAbiParameters('uint256, bytes32, uint32'),
      [this.config.dobbscoinChainId, this.txHash(r.depositTxid), r.depositVout]));
  }

  /** True if V2 already holds at least this refund for this output. */
  async isRecorded(r: RefundRecord): Promise<boolean> {
    const k = this.key(r);
    if ((this.seen.get(k) ?? -1n) >= r.refundedTotalSat) return true;
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

  /** Record it if needed; resolves true once V2 shows it. Throws on a failed or reverted tx. */
  async ensureRecorded(r: RefundRecord): Promise<boolean> {
    if (await this.isRecorded(r)) return true;
    const hash = await withRelayerLock(() => this.writer.writeContract({
      address: this.config.bridgeControllerAddress as Hex, abi: ABI, functionName: 'recordRefund',
      args: [this.txHash(r.depositTxid), r.depositVout, r.depositValueSat, r.refundedTotalSat],
    }));
    const rc = await this.reader.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`recordRefund reverted (${hash})`);
    this.seen.delete(this.key(r));
    return this.isRecorded(r);
  }
}
