/**
 * State definitions for both bridge flows.
 *
 * Inbound:  Dobbscoin deposit → Gnosis wBOB mint
 * Outbound: Gnosis wBOB burn  → Dobbscoin payout
 */

// ─── Inbound (deposit → mint) ────────────────────────────────────────────────

export enum InboundState {
  QUOTE_CREATED             = 'QUOTE_CREATED',
  DEPOSIT_ADDRESS_ASSIGNED  = 'DEPOSIT_ADDRESS_ASSIGNED',
  DEPOSIT_SEEN_MEMPOOL      = 'DEPOSIT_SEEN_MEMPOOL',
  DEPOSIT_CONFIRMED         = 'DEPOSIT_CONFIRMED',
  DEPOSIT_FINALIZED         = 'DEPOSIT_FINALIZED',
  MINT_AUTH_CREATED         = 'MINT_AUTH_CREATED',
  MINT_SUBMITTED            = 'MINT_SUBMITTED',
  MINT_CONFIRMED            = 'MINT_CONFIRMED',
  COMPLETED                 = 'COMPLETED',
  FAILED                    = 'FAILED',
  REFUNDED                  = 'REFUNDED',
}

/** States from which no further transitions are possible. */
export const INBOUND_TERMINAL_STATES = new Set<InboundState>([
  InboundState.COMPLETED,
  InboundState.REFUNDED,
]);

// ─── Outbound (burn → payout) ────────────────────────────────────────────────

export enum OutboundState {
  WITHDRAW_REQUEST_CREATED  = 'WITHDRAW_REQUEST_CREATED',
  BURN_TX_SEEN              = 'BURN_TX_SEEN',
  BURN_CONFIRMED            = 'BURN_CONFIRMED',
  PAYOUT_QUEUED             = 'PAYOUT_QUEUED',
  PAYOUT_SIGNED             = 'PAYOUT_SIGNED',
  PAYOUT_BROADCAST          = 'PAYOUT_BROADCAST',
  PAYOUT_CONFIRMED          = 'PAYOUT_CONFIRMED',
  COMPLETED                 = 'COMPLETED',
  FAILED                    = 'FAILED',
  MANUAL_REVIEW             = 'MANUAL_REVIEW',
}

export const OUTBOUND_TERMINAL_STATES = new Set<OutboundState>([
  OutboundState.COMPLETED,
]);
