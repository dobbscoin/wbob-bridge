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

/** Exactly OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG. */
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/i;

/**
 * The address an output pays, ONLY for a standard pay-to-pubkey-hash script.
 * Anything else (bare multisig, P2SH, P2PK, OP_RETURN, non-standard) returns
 * undefined, whatever the node lists under `addresses`.
 *
 * Why (2026-11 review round 4): a v0.14-era node reports a bare 1-of-2 multisig
 * as type "multisig" with addresses = [P2PKH of each pubkey]. Taking
 * addresses[0] let an attacker who knew a deposit address's pubkey (public once
 * the bridge spends from it) send `1-of-2 {bridge pubkey, attacker key}`: it
 * matched the deposit address, every watcher check passed, wBOB was minted,
 * and the attacker spent the output back with their own key.
 */
export function outputAddress(vout: RpcVout): string | undefined {
  const spk = vout.scriptPubKey;
  if (spk.type !== 'pubkeyhash' || !P2PKH_SCRIPT.test(spk.hex)) return undefined;
  if (spk.address) return spk.address;
  return spk.addresses?.length === 1 ? spk.addresses[0] : undefined;
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
