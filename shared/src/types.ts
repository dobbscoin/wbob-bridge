/**
 * Core bridge types shared across backend, watcher, and portal.
 *
 * Branded string types prevent mixing up address/hash/hex values at compile time.
 * No runtime dependencies — this package stays dependency-free so portal can import it too.
 */

// ─── Branded primitives ───────────────────────────────────────────────────────

export type Hex     = `0x${string}`;
export type Address = `0x${string}`;

/** keccak256 hash of the canonical deposit fields (see computeDepositId). */
export type DepositId = Hex;

// ─── Order types ──────────────────────────────────────────────────────────────

export type OrderType = 'inbound' | 'outbound';

// ─── MintAuthorization (mirrors BridgeController.sol struct) ─────────────────
//
// All watchers sign this struct via EIP-712.  The backend collects signatures
// until THRESHOLD (3) are gathered, then calls BridgeController.executeMint().

export interface MintAuthorization {
  depositId:     DepositId;  // keccak256 of canonical deposit params
  recipient:     Address;    // Gnosis address to receive wBOB
  amount:        bigint;     // satoshi units (8 decimals)
  sourceChainId: bigint;     // Dobbscoin numeric chain ID
  sourceTxHash:  Hex;        // Dobbscoin txid as bytes32 (zero-padded)
  sourceVout:    number;     // UTXO output index
  deadline:      bigint;     // unix timestamp — authorization expiry
  nonce:         bigint;     // must equal BridgeController.mintNonce()
}

// ─── WithdrawalRequest (mirrors BridgeController event) ──────────────────────

export interface WithdrawalRequest {
  withdrawalId:     bigint;  // uint256 from WithdrawalRequested event
  sender:           Address;
  amount:           bigint;  // satoshi units
  dobbscoinAddress: string;
  nonce:            bigint;  // withdrawalNonces[sender] at time of request
  burnTxHash:       Hex;
  burnBlockNumber:  bigint;
}

// ─── DepositId computation ────────────────────────────────────────────────────
//
// Canonical formula (must match BridgeController.sol comments):
//   depositId = keccak256(abi.encode(
//     sourceChainName,   // string
//     dobbscoinTxid,     // string (hex)
//     vout,              // uint32
//     depositAddress,    // string
//     rawAmountSat,      // uint256
//     recipientGnosisAddress // address
//   ))
//
// Actual computation lives in the watcher (Phase 3) which has viem available.
// This type anchors the interface contract.

export interface DepositIdParams {
  sourceChainName:        string;   // e.g. "dobbscoin-mainnet"
  dobbscoinTxid:          string;   // txid hex string
  vout:                   number;
  depositAddress:         string;   // Dobbscoin address
  rawAmountSat:           bigint;
  recipientGnosisAddress: Address;
}

// ─── Quote / order lifecycle ──────────────────────────────────────────────────

export interface Quote {
  quoteId:          string;   // UUID
  depositAddress:   string;   // assigned Dobbscoin address
  recipientAddress: Address;  // Gnosis recipient
  amountSat:        bigint;   // quoted input amount
  feeSat:           bigint;   // bridge fee
  expiresAt:        Date;
}

// ─── Solvency snapshot ────────────────────────────────────────────────────────

export interface SolvencySnapshot {
  lockedReserveSat:      bigint;  // on-chain Dobbscoin reserve
  circulatingWBobSat:    bigint;  // wBOB.totalSupply()
  pendingWithdrawalsSat: bigint;  // sum of PAYOUT_QUEUED + PAYOUT_SIGNED + PAYOUT_BROADCAST
  operationalBufferSat:  bigint;  // configured minimum buffer
  isSolvent:             boolean; // lockedReserve >= circulating + pending + buffer
  timestamp:             Date;
}

// ─── Utility: satoshi ↔ display conversion ───────────────────────────────────

export const SAT_PER_BOB = 100_000_000n;

export function satToBOB(sat: bigint): string {
  const whole = sat / SAT_PER_BOB;
  const frac  = (sat % SAT_PER_BOB).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

export function bobToSat(bob: string): bigint {
  const [whole, frac = ''] = bob.split('.');
  const fracPadded = frac.padEnd(8, '0').slice(0, 8);
  return BigInt(whole) * SAT_PER_BOB + BigInt(fracPadded);
}
