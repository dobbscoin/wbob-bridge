/**
 * Outbound state machine — pure, no I/O.
 *
 * Covers the Gnosis wBOB burn → Dobbscoin payout flow:
 *
 *   WITHDRAW_REQUEST_CREATED
 *     └─ BURN_TX_SEEN
 *          └─ BURN_CONFIRMED
 *               └─ PAYOUT_QUEUED
 *                    └─ PAYOUT_SIGNED
 *                         └─ PAYOUT_BROADCAST
 *                              └─ PAYOUT_CONFIRMED
 *                                   └─ COMPLETED
 *
 *   PAYOUT_QUEUED | PAYOUT_SIGNED | PAYOUT_BROADCAST | FAILED → MANUAL_REVIEW
 *   MANUAL_REVIEW → PAYOUT_QUEUED (retry) | FAILED (confirm failure)
 */

import { OutboundState, OUTBOUND_TERMINAL_STATES } from '../states.js';

// ─── Transition table ────────────────────────────────────────────────────────

export const OUTBOUND_TRANSITIONS: Readonly<Record<OutboundState, readonly OutboundState[]>> = {
  [OutboundState.WITHDRAW_REQUEST_CREATED]: [
    OutboundState.BURN_TX_SEEN,
    OutboundState.FAILED,
  ],
  [OutboundState.BURN_TX_SEEN]: [
    OutboundState.BURN_CONFIRMED,
    OutboundState.FAILED,             // reorg removed the burn TX
  ],
  [OutboundState.BURN_CONFIRMED]: [
    OutboundState.PAYOUT_QUEUED,
    OutboundState.FAILED,
  ],
  [OutboundState.PAYOUT_QUEUED]: [
    OutboundState.PAYOUT_SIGNED,
    OutboundState.FAILED,
    OutboundState.MANUAL_REVIEW,      // address validation fail, amount exceed limit, etc.
  ],
  [OutboundState.PAYOUT_SIGNED]: [
    OutboundState.PAYOUT_BROADCAST,
    OutboundState.FAILED,
    OutboundState.MANUAL_REVIEW,
  ],
  [OutboundState.PAYOUT_BROADCAST]: [
    OutboundState.PAYOUT_CONFIRMED,
    OutboundState.FAILED,             // TX dropped, fee too low
    OutboundState.MANUAL_REVIEW,
  ],
  [OutboundState.PAYOUT_CONFIRMED]: [
    OutboundState.COMPLETED,
  ],
  [OutboundState.COMPLETED]: [],      // terminal
  [OutboundState.FAILED]: [
    OutboundState.MANUAL_REVIEW,      // escalate for human inspection
  ],
  [OutboundState.MANUAL_REVIEW]: [
    OutboundState.PAYOUT_QUEUED,      // operator retries the payout
    OutboundState.FAILED,             // operator confirms the failure
  ],
} as const;

// ─── Pure FSM helpers ────────────────────────────────────────────────────────

export function canTransitionOutbound(from: OutboundState, to: OutboundState): boolean {
  return (OUTBOUND_TRANSITIONS[from] as readonly OutboundState[]).includes(to);
}

export function validOutboundNextStates(state: OutboundState): readonly OutboundState[] {
  return OUTBOUND_TRANSITIONS[state];
}

export function isOutboundTerminal(state: OutboundState): boolean {
  return OUTBOUND_TERMINAL_STATES.has(state);
}

// ─── FSMTransitionError ───────────────────────────────────────────────────────

export class OutboundTransitionError extends Error {
  constructor(
    public readonly from: OutboundState,
    public readonly to: OutboundState,
  ) {
    super(
      `Invalid outbound transition: ${from} → ${to}. ` +
      `Allowed: [${(OUTBOUND_TRANSITIONS[from] as readonly OutboundState[]).join(', ')}]`,
    );
    this.name = 'OutboundTransitionError';
  }
}

export function assertOutboundTransition(from: OutboundState, to: OutboundState): void {
  if (!canTransitionOutbound(from, to)) {
    throw new OutboundTransitionError(from, to);
  }
}
