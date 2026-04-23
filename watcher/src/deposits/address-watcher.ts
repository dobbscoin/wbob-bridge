/**
 * Address watcher — scans blocks and mempool for deposits to watched addresses.
 *
 * Pure: given a block or mempool map, returns matching outputs.
 * No DB, no FSM calls — callers decide what to do with matches.
 */

import { btcToSatoshis } from '../rpc/client.js';
import type { RpcBlock, RpcRawTransaction, RpcVout } from '../rpc/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A deposit output matched in a block or mempool transaction. */
export interface DepositMatch {
  txid: string;
  vout: number;
  /** Satoshi amount of this output. */
  amountSat: bigint;
  /** The Dobbscoin address this output pays to. */
  depositAddress: string;
  /** Block hash (undefined if seen in mempool only). */
  blockHash: string | undefined;
  /** Block height (undefined if seen in mempool only). */
  blockHeight: number | undefined;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the single address from a scriptPubKey, if present.
 * Returns undefined for non-standard outputs (OP_RETURN, multisig, etc.).
 */
function outputAddress(vout: RpcVout): string | undefined {
  return vout.scriptPubKey.address ?? vout.scriptPubKey.addresses?.[0];
}

/**
 * Scan a single transaction for outputs paying to any watched address.
 */
export function matchTransaction(
  tx: RpcRawTransaction,
  watchedAddresses: ReadonlySet<string>,
  blockHash?: string,
  blockHeight?: number,
): DepositMatch[] {
  const matches: DepositMatch[] = [];

  for (const out of tx.vout) {
    const addr = outputAddress(out);
    if (addr !== undefined && watchedAddresses.has(addr)) {
      matches.push({
        txid: tx.txid,
        vout: out.n,
        amountSat: btcToSatoshis(out.value),
        depositAddress: addr,
        blockHash,
        blockHeight,
      });
    }
  }

  return matches;
}

/**
 * Scan an entire block for deposits to watched addresses.
 */
export function matchBlock(
  block: RpcBlock,
  watchedAddresses: ReadonlySet<string>,
): DepositMatch[] {
  const matches: DepositMatch[] = [];

  for (const tx of block.tx) {
    const txMatches = matchTransaction(tx, watchedAddresses, block.hash, block.height);
    matches.push(...txMatches);
  }

  return matches;
}
