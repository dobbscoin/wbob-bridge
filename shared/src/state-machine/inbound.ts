/**
 * Inbound state machine — pure, no I/O.
 *
 * Covers the Dobbscoin deposit → Gnosis wBOB mint flow:
 *
 *   QUOTE_CREATED
 *     └─ DEPOSIT_ADDRESS_ASSIGNED
 *          └─ DEPOSIT_SEEN_MEMPOOL
 *               └─ DEPOSIT_CONFIRMED ←──────────────────────┐
 *                    ├─ DEPOSIT_CONFIRMED → DEPOSIT_SEEN_MEMPOOL (reorg)
 *                    └─ DEPOSIT_FINALIZED
 *                         └─ MINT_AUTH_CREATED
 *                              └─ MINT_SUBMITTED
 *                                   └─ MINT_CONFIRMED
 *                                        └─ COMPLETED
 *
 *   Any non-terminal state → FAILED → REFUNDED
 */

import { InboundState, INBOUND_TERMINAL_STATES } from '../states.js';

// ─── Transition table ────────────────────────────────────────────────────────

/** Allowed next states keyed by current state. */
export const INBOUND_TRANSITIONS: Readonly<Record<InboundState, readonly InboundState[]>> = {
  [InboundState.QUOTE_CREATED]: [
    InboundState.DEPOSIT_ADDRESS_ASSIGNED,
    InboundState.FAILED,
  ],
  [InboundState.DEPOSIT_ADDRESS_ASSIGNED]: [
    InboundState.DEPOSIT_SEEN_MEMPOOL,
    InboundState.FAILED,
  ],
  [InboundState.DEPOSIT_SEEN_MEMPOOL]: [
    InboundState.DEPOSIT_CONFIRMED,
    InboundState.FAILED,                  // double-spend, TX dropped from mempool
  ],
  [InboundState.DEPOSIT_CONFIRMED]: [
    InboundState.DEPOSIT_FINALIZED,
    InboundState.DEPOSIT_SEEN_MEMPOOL,    // reorg rolled back below threshold
    InboundState.FAILED,
  ],
  [InboundState.DEPOSIT_FINALIZED]: [
    InboundState.MINT_AUTH_CREATED,
    InboundState.FAILED,
  ],
  [InboundState.MINT_AUTH_CREATED]: [
    InboundState.MINT_SUBMITTED,
    InboundState.FAILED,
  ],
  [InboundState.MINT_SUBMITTED]: [
    InboundState.MINT_CONFIRMED,
    InboundState.FAILED,                  // executeMint reverted on-chain
  ],
  [InboundState.MINT_CONFIRMED]: [
    InboundState.COMPLETED,
  ],
  [InboundState.COMPLETED]: [],           // terminal
  [InboundState.FAILED]: [
    InboundState.REFUNDED,
  ],
  [InboundState.REFUNDED]: [],            // terminal
} as const;

// ─── Pure FSM helpers ────────────────────────────────────────────────────────

/**
 * Returns true if transitioning from → to is a valid edge in the graph.
 */
export function canTransitionInbound(from: InboundState, to: InboundState): boolean {
  return (INBOUND_TRANSITIONS[from] as readonly InboundState[]).includes(to);
}

/**
 * Returns all valid next states from `state`.
 */
export function validNextStates(state: InboundState): readonly InboundState[] {
  return INBOUND_TRANSITIONS[state];
}

/**
 * Returns true if `state` is a terminal node (no outgoing edges).
 */
export function isInboundTerminal(state: InboundState): boolean {
  return INBOUND_TERMINAL_STATES.has(state);
}

// ─── FSMTransitionError ───────────────────────────────────────────────────────

export class InboundTransitionError extends Error {
  constructor(
    public readonly from: InboundState,
    public readonly to: InboundState,
  ) {
    super(
      `Invalid inbound transition: ${from} → ${to}. ` +
      `Allowed: [${(INBOUND_TRANSITIONS[from] as readonly InboundState[]).join(', ')}]`,
    );
    this.name = 'InboundTransitionError';
  }
}

/**
 * Validates a transition and throws InboundTransitionError if invalid.
 * Use this as a guard before persisting state changes.
 */
export function assertInboundTransition(from: InboundState, to: InboundState): void {
  if (!canTransitionInbound(from, to)) {
    throw new InboundTransitionError(from, to);
  }
}
