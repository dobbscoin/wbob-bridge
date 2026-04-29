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
  created_at:          Date;
  updated_at:          Date;
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
  | 'wallet_dry';

export interface GasDripRow {
  recipient_gnosis_address: string;
  status:                   GasDripStatus;
  order_id:                 string | null;
  amount_wei:               string | null; // NUMERIC(78,0) → string
  gnosis_tx_hash:           string | null;
  error:                    string | null;
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
