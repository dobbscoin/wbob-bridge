/**
 * TypeScript row types that mirror the PostgreSQL schema exactly.
 *
 * Rules:
 *  - BIGINT columns → bigint  (postgres driver returns string by default;
 *    configure the client to parse int8 as BigInt — see client.ts)
 *  - NUMERIC        → string  (uint256 won't fit in JS number or BigInt safely
 *                              when returned raw; convert at use-site)
 *  - BYTEA          → Buffer  (postgres driver returns Buffer for BYTEA)
 *  - JSONB          → unknown (narrow at use-site with Zod)
 *  - UUID           → string
 *  - TIMESTAMPTZ    → Date
 */

import type { InboundState, OutboundState } from '@wbob/shared';

// ─── bridge_orders ───────────────────────────────────────────────────────────

export interface BridgeOrderRow {
  id:                    string;
  order_type:            'inbound' | 'outbound';
  state:                 InboundState | OutboundState;
  user_gnosis_address:   string | null;
  user_dobbscoin_address: string | null;
  amount_sat:            bigint | null;
  fee_sat:               bigint | null;
  expires_at:            Date | null;
  created_at:            Date;
  updated_at:            Date;
}

// ─── source_deposits ─────────────────────────────────────────────────────────

export interface SourceDepositRow {
  id:                string;
  order_id:          string;
  deposit_id:        Buffer | null;  // bytes32 keccak256 — null until deposit seen on-chain
  deposit_address:   string;
  hd_index:          number | null;
  source_chain_name: string;
  txid:              string | null;
  vout:              number | null;
  amount_sat:        bigint | null;
  confirmations:     number;
  block_height:      number | null;
  block_hash:        string | null;
  seen_mempool_at:   Date | null;
  confirmed_at:      Date | null;
  finalized_at:      Date | null;
  created_at:        Date;
  updated_at:        Date;
}

// ─── mint_requests ───────────────────────────────────────────────────────────

export interface MintRequestRow {
  id:                  string;
  order_id:            string;
  deposit_id:          Buffer;
  recipient_address:   string;
  amount_sat:          bigint;
  mint_nonce:          bigint;
  deadline:            bigint;
  mint_authorization:  unknown | null;  // full MintAuthorization JSON (for reference)
  signatures:          unknown;         // Array<{signer, sig}> JSON
  signature_count:     number;
  gnosis_tx_hash:      string | null;
  gnosis_block_number: bigint | null;
  confirmed_at:        Date | null;
  /** What arrived; amount_sat (the minted part) is less when the daily cap split it. NULL = pre-012 row. */
  deposit_amount_sat:  bigint | null;
  cap_decision:        unknown | null;  // JSON snapshot of the cap state the split was decided on
  regenerated_count:   number;
  last_submit_error:   string | null;
  last_submit_error_at: Date | null;
  created_at:          Date;
  updated_at:          Date;
}

// ─── deposit_refunds ─────────────────────────────────────────────────────────

export type DepositRefundStatus =
  | 'queued'
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'needs_attention'
  | 'too_small';

export interface DepositRefundRow {
  id:                 string;
  order_id:           string;
  deposit_txid:       string;
  deposit_vout:       number;
  deposit_amount_sat: bigint;
  mint_amount_sat:    bigint;
  excess_sat:         bigint;
  refund_address:     string | null;
  sender_detail:      unknown | null;
  status:             DepositRefundStatus;
  reason:             string | null;
  amount_sat:         bigint | null;   // paid to the sender (excess − fee share)
  fee_sat:            bigint | null;
  bridge_fee_sat:     bigint;
  signed_hex:         string | null;
  txid:               string | null;
  change_sat:         bigint | null;
  change_address:     string | null;
  change_index:       number | null;
  confirmations:      number;
  split_alerted_at:   Date | null;
  signed_at:          Date | null;
  broadcast_at:       Date | null;
  confirmed_at:       Date | null;
  created_at:         Date;
  updated_at:         Date;
}

// ─── withdrawal_requests ─────────────────────────────────────────────────────

export interface WithdrawalRequestRow {
  id:                string;
  order_id:          string;
  withdrawal_id:     string;  // NUMERIC → string (uint256)
  sender_address:    string;
  dobbscoin_address: string;
  amount_sat:        bigint;
  user_nonce:        bigint;
  burn_tx_hash:      string | null;
  burn_block_number: bigint | null;
  burn_confirmed_at: Date | null;
  created_at:        Date;
  updated_at:        Date;
}

// ─── payouts ─────────────────────────────────────────────────────────────────

export interface PayoutRow {
  id:                    string;
  withdrawal_request_id: string;
  dobbscoin_address:     string;
  amount_sat:            bigint;
  fee_sat:               bigint | null;
  txid:                  string | null;
  vout:                  number | null;
  confirmations:         number;
  broadcast_at:          Date | null;
  confirmed_at:          Date | null;
  created_at:            Date;
  updated_at:            Date;
}

// ─── bridge_utxos ────────────────────────────────────────────────────────────

export interface BridgeUtxoRow {
  id:              string;
  order_id:        string;
  txid:            string;
  vout:            number;
  amount_sat:      bigint;
  address:         string;
  hd_index:        number;
  status:          'available' | 'reserved' | 'spent';
  spent_payout_id: string | null;
  spent_refund_id: string | null;
  created_at:      Date;
  updated_at:      Date;
}

// ─── bridge_state ─────────────────────────────────────────────────────────────

export interface BridgeStateRow {
  key:        string;
  value:      string;
  updated_at: Date;
}

// ─── gas_drips ───────────────────────────────────────────────────────────────

export type GasDripStatus =
  | 'opted_in'
  | 'opted_out'
  | 'sent'
  | 'failed'
  | 'wallet_dry'
  | 'recipient_has_gas';   // skipped: recipient already had xDAI; still eligible later

export interface GasDripRow {
  recipient_gnosis_address: string;
  status:                   GasDripStatus;
  order_id:                 string | null;
  amount_wei:               string | null; // NUMERIC(78,0) → string
  gnosis_tx_hash:           string | null;
  error:                    string | null;
  recipient_balance_wei:    string | null; // NUMERIC → string; balance seen at the last skip
  created_at:               Date;
  updated_at:               Date;
  sent_at:                  Date | null;
}

// ─── audit_events ────────────────────────────────────────────────────────────

export interface AuditEventRow {
  id:         bigint;
  order_id:   string;
  event_type: string;
  from_state: string | null;
  to_state:   string;
  actor:      string | null;
  metadata:   unknown | null;
  created_at: Date;
}
