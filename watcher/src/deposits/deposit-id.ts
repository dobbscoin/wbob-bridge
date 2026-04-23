/**
 * DepositId computation.
 *
 * Canonical formula (must match BridgeController.sol comments):
 *
 *   depositId = keccak256(abi.encode(
 *     sourceChainName,         // string  — e.g. "dobbscoin-mainnet"
 *     dobbscoinTxid,           // string  — txid hex string (RPC big-endian display)
 *     vout,                    // uint32
 *     depositAddress,          // string  — Dobbscoin deposit address
 *     rawAmountSat,            // uint256 — satoshis
 *     recipientGnosisAddress   // address
 *   ))
 *
 * All 5 watchers must produce the same bytes — this function is the single
 * source of truth.  The BridgeController stores whatever bytes32 arrives in
 * MintAuthorization.depositId; it never re-derives it.
 */

import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import type { DepositIdParams, Hex } from '@wbob/shared';

export type { DepositIdParams };

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Compute the canonical depositId for a Dobbscoin UTXO deposit.
 * Returns a 0x-prefixed 32-byte hex string (Hex / bytes32).
 */
export function computeDepositId(params: DepositIdParams): Hex {
  const {
    sourceChainName,
    dobbscoinTxid,
    vout,
    depositAddress,
    rawAmountSat,
    recipientGnosisAddress,
  } = params;

  const encoded = encodeAbiParameters(
    parseAbiParameters('string, string, uint32, string, uint256, address'),
    [
      sourceChainName,
      dobbscoinTxid,
      vout,
      depositAddress,
      rawAmountSat,
      recipientGnosisAddress,
    ],
  );

  return keccak256(encoded) as Hex;
}
