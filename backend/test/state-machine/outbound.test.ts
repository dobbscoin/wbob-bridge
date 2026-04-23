import { describe, it, expect } from 'vitest';
import {
  OutboundState,
  OUTBOUND_TERMINAL_STATES,
  OUTBOUND_TRANSITIONS,
  canTransitionOutbound,
  validOutboundNextStates,
  isOutboundTerminal,
  assertOutboundTransition,
  OutboundTransitionError,
} from '@wbob/shared';

const ALL_STATES = Object.values(OutboundState);

// ─── Transition table shape ───────────────────────────────────────────────────

describe('OUTBOUND_TRANSITIONS table', () => {
  it('covers every OutboundState exactly once', () => {
    const keys = Object.keys(OUTBOUND_TRANSITIONS);
    expect(keys.sort()).toEqual(ALL_STATES.sort());
  });

  it('contains no duplicate target states within any source state', () => {
    for (const [from, targets] of Object.entries(OUTBOUND_TRANSITIONS)) {
      const unique = new Set(targets);
      expect(unique.size, `duplicates in ${from}`).toBe(targets.length);
    }
  });

  it('has only valid OutboundState values as targets', () => {
    const valid = new Set(ALL_STATES);
    for (const [from, targets] of Object.entries(OUTBOUND_TRANSITIONS)) {
      for (const t of targets) {
        expect(valid.has(t as OutboundState), `${from} → ${t} is not a valid state`).toBe(true);
      }
    }
  });
});

// ─── Terminal states ──────────────────────────────────────────────────────────

describe('terminal states', () => {
  it('COMPLETED has no outgoing transitions', () => {
    expect(OUTBOUND_TRANSITIONS[OutboundState.COMPLETED]).toHaveLength(0);
  });

  it('isOutboundTerminal returns true only for COMPLETED', () => {
    const terminals = ALL_STATES.filter(isOutboundTerminal);
    expect(terminals.sort()).toEqual([...OUTBOUND_TERMINAL_STATES].sort());
  });

  it('non-terminal states have at least one outgoing transition', () => {
    for (const s of ALL_STATES) {
      if (!isOutboundTerminal(s)) {
        expect(
          OUTBOUND_TRANSITIONS[s].length,
          `${s} is non-terminal but has no transitions`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ─── canTransitionOutbound ───────────────────────────────────────────────────

describe('canTransitionOutbound', () => {
  const VALID: Array<[OutboundState, OutboundState]> = [
    [OutboundState.WITHDRAW_REQUEST_CREATED, OutboundState.BURN_TX_SEEN],
    [OutboundState.BURN_TX_SEEN,             OutboundState.BURN_CONFIRMED],
    [OutboundState.BURN_CONFIRMED,           OutboundState.PAYOUT_QUEUED],
    [OutboundState.PAYOUT_QUEUED,            OutboundState.PAYOUT_SIGNED],
    [OutboundState.PAYOUT_SIGNED,            OutboundState.PAYOUT_BROADCAST],
    [OutboundState.PAYOUT_BROADCAST,         OutboundState.PAYOUT_CONFIRMED],
    [OutboundState.PAYOUT_CONFIRMED,         OutboundState.COMPLETED],
    // FAILED paths
    [OutboundState.WITHDRAW_REQUEST_CREATED, OutboundState.FAILED],
    [OutboundState.BURN_TX_SEEN,             OutboundState.FAILED],
    [OutboundState.BURN_CONFIRMED,           OutboundState.FAILED],
    [OutboundState.PAYOUT_QUEUED,            OutboundState.FAILED],
    [OutboundState.PAYOUT_SIGNED,            OutboundState.FAILED],
    [OutboundState.PAYOUT_BROADCAST,         OutboundState.FAILED],
    // MANUAL_REVIEW paths
    [OutboundState.PAYOUT_QUEUED,            OutboundState.MANUAL_REVIEW],
    [OutboundState.PAYOUT_SIGNED,            OutboundState.MANUAL_REVIEW],
    [OutboundState.PAYOUT_BROADCAST,         OutboundState.MANUAL_REVIEW],
    [OutboundState.FAILED,                   OutboundState.MANUAL_REVIEW],
    // MANUAL_REVIEW recovery
    [OutboundState.MANUAL_REVIEW,            OutboundState.PAYOUT_QUEUED],
    [OutboundState.MANUAL_REVIEW,            OutboundState.FAILED],
  ];

  for (const [from, to] of VALID) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransitionOutbound(from, to)).toBe(true);
    });
  }

  const INVALID: Array<[OutboundState, OutboundState]> = [
    [OutboundState.COMPLETED,                OutboundState.FAILED],         // terminal
    [OutboundState.COMPLETED,                OutboundState.COMPLETED],      // self-loop
    [OutboundState.PAYOUT_CONFIRMED,         OutboundState.PAYOUT_QUEUED],  // backward
    [OutboundState.BURN_CONFIRMED,           OutboundState.PAYOUT_CONFIRMED], // skip
    [OutboundState.WITHDRAW_REQUEST_CREATED, OutboundState.BURN_CONFIRMED],  // skip
    [OutboundState.PAYOUT_BROADCAST,         OutboundState.BURN_TX_SEEN],   // backward
    [OutboundState.MANUAL_REVIEW,            OutboundState.PAYOUT_BROADCAST], // can't skip back
    [OutboundState.MANUAL_REVIEW,            OutboundState.COMPLETED],       // must go through PAYOUT
  ];

  for (const [from, to] of INVALID) {
    it(`rejects ${from} → ${to}`, () => {
      expect(canTransitionOutbound(from, to)).toBe(false);
    });
  }
});

// ─── MANUAL_REVIEW semantics ─────────────────────────────────────────────────

describe('MANUAL_REVIEW semantics', () => {
  it('MANUAL_REVIEW can retry from PAYOUT_QUEUED', () => {
    expect(canTransitionOutbound(
      OutboundState.MANUAL_REVIEW, OutboundState.PAYOUT_QUEUED,
    )).toBe(true);
  });

  it('MANUAL_REVIEW can confirm failure', () => {
    expect(canTransitionOutbound(
      OutboundState.MANUAL_REVIEW, OutboundState.FAILED,
    )).toBe(true);
  });

  it('MANUAL_REVIEW cannot directly complete', () => {
    expect(canTransitionOutbound(
      OutboundState.MANUAL_REVIEW, OutboundState.COMPLETED,
    )).toBe(false);
  });
});

// ─── assertOutboundTransition ────────────────────────────────────────────────

describe('assertOutboundTransition', () => {
  it('does not throw on valid transition', () => {
    expect(() =>
      assertOutboundTransition(OutboundState.BURN_TX_SEEN, OutboundState.BURN_CONFIRMED),
    ).not.toThrow();
  });

  it('throws OutboundTransitionError on invalid transition', () => {
    expect(() =>
      assertOutboundTransition(OutboundState.COMPLETED, OutboundState.FAILED),
    ).toThrow(OutboundTransitionError);
  });

  it('error carries from/to fields', () => {
    let caught: OutboundTransitionError | undefined;
    try {
      assertOutboundTransition(OutboundState.COMPLETED, OutboundState.FAILED);
    } catch (e) {
      caught = e as OutboundTransitionError;
    }
    expect(caught!.from).toBe(OutboundState.COMPLETED);
    expect(caught!.to).toBe(OutboundState.FAILED);
  });
});

// ─── Reachability ────────────────────────────────────────────────────────────

describe('graph reachability', () => {
  function reachableFrom(start: OutboundState): Set<OutboundState> {
    const visited = new Set<OutboundState>();
    const queue: OutboundState[] = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of OUTBOUND_TRANSITIONS[node]) {
        queue.push(next);
      }
    }
    return visited;
  }

  it('every state is reachable from WITHDRAW_REQUEST_CREATED', () => {
    const reachable = reachableFrom(OutboundState.WITHDRAW_REQUEST_CREATED);
    for (const s of ALL_STATES) {
      expect(reachable.has(s), `${s} is not reachable`).toBe(true);
    }
  });

  it('COMPLETED is reachable on the happy path', () => {
    const reachable = reachableFrom(OutboundState.WITHDRAW_REQUEST_CREATED);
    expect(reachable.has(OutboundState.COMPLETED)).toBe(true);
  });
});

// ─── shared/types satoshi helpers ────────────────────────────────────────────
// Smoke-test the satToBOB / bobToSat helpers while we're here.

import { satToBOB, bobToSat, SAT_PER_BOB } from '@wbob/shared';

describe('satoshi conversion helpers', () => {
  it('SAT_PER_BOB is 1e8', () => {
    expect(SAT_PER_BOB).toBe(100_000_000n);
  });

  it('satToBOB(100_000_000n) = "1.00000000"', () => {
    expect(satToBOB(100_000_000n)).toBe('1.00000000');
  });

  it('satToBOB(1n) = "0.00000001"', () => {
    expect(satToBOB(1n)).toBe('0.00000001');
  });

  it('satToBOB(21_000_000 * 1e8) = "21000000.00000000"', () => {
    expect(satToBOB(21_000_000n * 100_000_000n)).toBe('21000000.00000000');
  });

  it('bobToSat("1.5") = 150_000_000n', () => {
    expect(bobToSat('1.5')).toBe(150_000_000n);
  });

  it('bobToSat("0.00000001") = 1n', () => {
    expect(bobToSat('0.00000001')).toBe(1n);
  });

  it('round-trip: satToBOB(bobToSat(x)) = x', () => {
    const cases = ['1.00000000', '0.12345678', '21000000.00000000'];
    for (const c of cases) {
      expect(satToBOB(bobToSat(c))).toBe(c);
    }
  });
});
