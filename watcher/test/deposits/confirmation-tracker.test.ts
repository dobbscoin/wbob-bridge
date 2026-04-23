/**
 * Confirmation tracker unit tests — pure, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  computeConfirmationTransition,
  computeReorgRollback,
  DEFAULT_CONFIRMATION_CONFIG,
} from '../../src/deposits/confirmation-tracker.js';
import { InboundState } from '@wbob/shared';

const CFG = DEFAULT_CONFIRMATION_CONFIG; // { minConfirmations: 3, finalConfirmations: 6 }

// ─── computeConfirmationTransition ───────────────────────────────────────────

describe('computeConfirmationTransition', () => {

  // ── 0 confirmations (mempool) ───────────────────────────────────────────

  it('0 confs + DEPOSIT_ADDRESS_ASSIGNED → DEPOSIT_SEEN_MEMPOOL', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_ADDRESS_ASSIGNED, 0, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('0 confs + DEPOSIT_SEEN_MEMPOOL → null (already at mempool state)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_SEEN_MEMPOOL, 0, CFG);
    expect(result.transition).toBeNull();
  });

  it('0 confs + DEPOSIT_CONFIRMED → null (would be reorg, handled separately)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_CONFIRMED, 0, CFG);
    expect(result.transition).toBeNull();
  });

  // ── 1-2 confs (below min threshold) ────────────────────────────────────

  it('1 conf + DEPOSIT_ADDRESS_ASSIGNED → DEPOSIT_SEEN_MEMPOOL', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_ADDRESS_ASSIGNED, 1, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('2 confs + DEPOSIT_SEEN_MEMPOOL → null (not at min threshold yet)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_SEEN_MEMPOOL, 2, CFG);
    expect(result.transition).toBeNull();
  });

  // ── >= minConfirmations ─────────────────────────────────────────────────

  it('3 confs + DEPOSIT_SEEN_MEMPOOL → DEPOSIT_CONFIRMED', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_SEEN_MEMPOOL, 3, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_CONFIRMED);
  });

  it('3 confs + DEPOSIT_ADDRESS_ASSIGNED → DEPOSIT_CONFIRMED (skips SEEN_MEMPOOL)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_ADDRESS_ASSIGNED, 3, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_CONFIRMED);
  });

  it('4 confs + DEPOSIT_CONFIRMED → null (already confirmed, not yet at final)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_CONFIRMED, 4, CFG);
    expect(result.transition).toBeNull();
  });

  // ── >= finalConfirmations ───────────────────────────────────────────────

  it('6 confs + DEPOSIT_CONFIRMED → DEPOSIT_FINALIZED', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_CONFIRMED, 6, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_FINALIZED);
  });

  it('6 confs + DEPOSIT_SEEN_MEMPOOL → DEPOSIT_FINALIZED (skips CONFIRMED)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_SEEN_MEMPOOL, 6, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_FINALIZED);
  });

  it('10 confs + DEPOSIT_CONFIRMED → DEPOSIT_FINALIZED', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_CONFIRMED, 10, CFG);
    expect(result.transition).toBe(InboundState.DEPOSIT_FINALIZED);
  });

  it('6 confs + DEPOSIT_FINALIZED → null (already finalized)', () => {
    const result = computeConfirmationTransition(InboundState.DEPOSIT_FINALIZED, 6, CFG);
    expect(result.transition).toBeNull();
  });

  // ── Terminal / irrelevant states ────────────────────────────────────────

  it('any conf + MINT_AUTH_CREATED → null', () => {
    const result = computeConfirmationTransition(InboundState.MINT_AUTH_CREATED, 10, CFG);
    expect(result.transition).toBeNull();
  });

  it('any conf + COMPLETED → null', () => {
    const result = computeConfirmationTransition(InboundState.COMPLETED, 100, CFG);
    expect(result.transition).toBeNull();
  });

  // ── Custom config ───────────────────────────────────────────────────────

  it('respects custom minConfirmations', () => {
    const custom = { minConfirmations: 1, finalConfirmations: 3 };
    const result = computeConfirmationTransition(InboundState.DEPOSIT_SEEN_MEMPOOL, 1, custom);
    expect(result.transition).toBe(InboundState.DEPOSIT_CONFIRMED);
  });

  it('respects custom finalConfirmations', () => {
    const custom = { minConfirmations: 1, finalConfirmations: 2 };
    const result = computeConfirmationTransition(InboundState.DEPOSIT_CONFIRMED, 2, custom);
    expect(result.transition).toBe(InboundState.DEPOSIT_FINALIZED);
  });
});

// ─── computeReorgRollback ────────────────────────────────────────────────────

describe('computeReorgRollback', () => {
  it('DEPOSIT_CONFIRMED + 0 confs → DEPOSIT_SEEN_MEMPOOL', () => {
    expect(computeReorgRollback(InboundState.DEPOSIT_CONFIRMED, 0, CFG))
      .toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('DEPOSIT_CONFIRMED + 1 conf → DEPOSIT_SEEN_MEMPOOL (below min)', () => {
    expect(computeReorgRollback(InboundState.DEPOSIT_CONFIRMED, 1, CFG))
      .toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('DEPOSIT_CONFIRMED + 2 confs → DEPOSIT_SEEN_MEMPOOL (below min=3)', () => {
    expect(computeReorgRollback(InboundState.DEPOSIT_CONFIRMED, 2, CFG))
      .toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('DEPOSIT_CONFIRMED + 3 confs → null (still above min)', () => {
    expect(computeReorgRollback(InboundState.DEPOSIT_CONFIRMED, 3, CFG)).toBeNull();
  });

  it('DEPOSIT_SEEN_MEMPOOL rollback → null (already at mempool state)', () => {
    expect(computeReorgRollback(InboundState.DEPOSIT_SEEN_MEMPOOL, 0, CFG)).toBeNull();
  });

  it('DEPOSIT_FINALIZED rollback → null (no FSM edge for that)', () => {
    // FSM does NOT allow FINALIZED → CONFIRMED or FINALIZED → SEEN_MEMPOOL
    expect(computeReorgRollback(InboundState.DEPOSIT_FINALIZED, 0, CFG)).toBeNull();
  });

  it('COMPLETED rollback → null', () => {
    expect(computeReorgRollback(InboundState.COMPLETED, 0, CFG)).toBeNull();
  });
});
