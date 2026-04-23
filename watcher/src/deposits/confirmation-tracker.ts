/**
 * Confirmation tracker.
 *
 * Given a deposit's confirmation count and the bridge configuration, determines
 * which FSM transition (if any) to apply.
 *
 * Thresholds:
 *   0 confirmations  → DEPOSIT_SEEN_MEMPOOL
 *   >= MIN_CONFS     → DEPOSIT_CONFIRMED
 *   >= FINAL_CONFS   → DEPOSIT_FINALIZED
 *
 * Pure: no I/O, no DB. Returns transition intent; caller applies it.
 */

import { InboundState } from '@wbob/shared';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ConfirmationConfig {
  /** Confirmations needed to move to DEPOSIT_CONFIRMED. Default: 3. */
  minConfirmations: number;
  /** Confirmations needed to move to DEPOSIT_FINALIZED. Default: 6. */
  finalConfirmations: number;
}

export const DEFAULT_CONFIRMATION_CONFIG: ConfirmationConfig = {
  minConfirmations: 3,
  finalConfirmations: 6,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfirmationTransition =
  | { transition: InboundState.DEPOSIT_SEEN_MEMPOOL }
  | { transition: InboundState.DEPOSIT_CONFIRMED }
  | { transition: InboundState.DEPOSIT_FINALIZED }
  | { transition: null };

// ─── Pure helper ─────────────────────────────────────────────────────────────

/**
 * Compute the target FSM state for a deposit given its current confirmation
 * count and its current FSM state.
 *
 * Returns `{ transition: null }` if no state change is needed (e.g. already
 * finalized, or confirmation count hasn't crossed the next threshold).
 */
export function computeConfirmationTransition(
  currentState: InboundState,
  confirmations: number,
  config: ConfirmationConfig = DEFAULT_CONFIRMATION_CONFIG,
): ConfirmationTransition {
  const { minConfirmations, finalConfirmations } = config;

  if (confirmations === 0) {
    // Mempool visibility
    if (currentState === InboundState.DEPOSIT_ADDRESS_ASSIGNED) {
      return { transition: InboundState.DEPOSIT_SEEN_MEMPOOL };
    }
    return { transition: null };
  }

  if (confirmations >= finalConfirmations) {
    if (
      currentState === InboundState.DEPOSIT_CONFIRMED ||
      currentState === InboundState.DEPOSIT_SEEN_MEMPOOL ||
      currentState === InboundState.DEPOSIT_ADDRESS_ASSIGNED
    ) {
      return { transition: InboundState.DEPOSIT_FINALIZED };
    }
    return { transition: null };
  }

  if (confirmations >= minConfirmations) {
    if (
      currentState === InboundState.DEPOSIT_SEEN_MEMPOOL ||
      currentState === InboundState.DEPOSIT_ADDRESS_ASSIGNED
    ) {
      return { transition: InboundState.DEPOSIT_CONFIRMED };
    }
    return { transition: null };
  }

  // Between 1 and minConfirmations-1: seen in a block but not yet at threshold.
  // If currently in DEPOSIT_ADDRESS_ASSIGNED, advance to SEEN_MEMPOOL.
  if (currentState === InboundState.DEPOSIT_ADDRESS_ASSIGNED) {
    return { transition: InboundState.DEPOSIT_SEEN_MEMPOOL };
  }

  return { transition: null };
}

/**
 * Compute the reorg-rollback transition for a deposit that was CONFIRMED or
 * FINALIZED but whose block was orphaned and its confirmation count dropped.
 *
 * Returns the FSM state to roll back to, or null if no rollback needed.
 */
export function computeReorgRollback(
  currentState: InboundState,
  newConfirmations: number,
  config: ConfirmationConfig = DEFAULT_CONFIRMATION_CONFIG,
): InboundState | null {
  // DEPOSIT_FINALIZED → DEPOSIT_CONFIRMED is not a valid FSM edge.
  // DEPOSIT_CONFIRMED → DEPOSIT_SEEN_MEMPOOL IS valid (reorg edge).
  if (
    currentState === InboundState.DEPOSIT_CONFIRMED &&
    newConfirmations < config.minConfirmations
  ) {
    return InboundState.DEPOSIT_SEEN_MEMPOOL;
  }

  return null;
}
