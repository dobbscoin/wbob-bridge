import { describe, it, expect } from 'vitest';
import {
  InboundState,
  INBOUND_TERMINAL_STATES,
  INBOUND_TRANSITIONS,
  canTransitionInbound,
  validNextStates,
  isInboundTerminal,
  assertInboundTransition,
  InboundTransitionError,
} from '@wbob/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ALL_STATES = Object.values(InboundState);

// ─── Transition table shape ───────────────────────────────────────────────────

describe('INBOUND_TRANSITIONS table', () => {
  it('covers every InboundState exactly once', () => {
    const keys = Object.keys(INBOUND_TRANSITIONS);
    expect(keys.sort()).toEqual(ALL_STATES.sort());
  });

  it('contains no duplicate target states within any source state', () => {
    for (const [from, targets] of Object.entries(INBOUND_TRANSITIONS)) {
      const unique = new Set(targets);
      expect(unique.size, `duplicates in ${from}`).toBe(targets.length);
    }
  });

  it('has only valid InboundState values as targets', () => {
    const valid = new Set(ALL_STATES);
    for (const [from, targets] of Object.entries(INBOUND_TRANSITIONS)) {
      for (const t of targets) {
        expect(valid.has(t as InboundState), `${from} → ${t} is not a valid state`).toBe(true);
      }
    }
  });
});

// ─── Terminal states ──────────────────────────────────────────────────────────

describe('terminal states', () => {
  it('COMPLETED has no outgoing transitions', () => {
    expect(INBOUND_TRANSITIONS[InboundState.COMPLETED]).toHaveLength(0);
  });

  it('REFUNDED has no outgoing transitions', () => {
    expect(INBOUND_TRANSITIONS[InboundState.REFUNDED]).toHaveLength(0);
  });

  it('isInboundTerminal returns true for COMPLETED and REFUNDED only', () => {
    const terminals = ALL_STATES.filter(isInboundTerminal);
    expect(terminals.sort()).toEqual(
      [...INBOUND_TERMINAL_STATES].sort(),
    );
  });

  it('non-terminal states all have at least one outgoing transition', () => {
    for (const s of ALL_STATES) {
      if (!isInboundTerminal(s)) {
        expect(
          INBOUND_TRANSITIONS[s].length,
          `${s} is non-terminal but has no outgoing transitions`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ─── canTransitionInbound ─────────────────────────────────────────────────────

describe('canTransitionInbound', () => {
  // Happy-path: explicit valid transitions
  const VALID: Array<[InboundState, InboundState]> = [
    [InboundState.QUOTE_CREATED,            InboundState.DEPOSIT_ADDRESS_ASSIGNED],
    [InboundState.DEPOSIT_ADDRESS_ASSIGNED, InboundState.DEPOSIT_SEEN_MEMPOOL],
    [InboundState.DEPOSIT_SEEN_MEMPOOL,     InboundState.DEPOSIT_CONFIRMED],
    [InboundState.DEPOSIT_CONFIRMED,        InboundState.DEPOSIT_FINALIZED],
    [InboundState.DEPOSIT_CONFIRMED,        InboundState.DEPOSIT_SEEN_MEMPOOL], // reorg
    [InboundState.DEPOSIT_FINALIZED,        InboundState.MINT_AUTH_CREATED],
    [InboundState.MINT_AUTH_CREATED,        InboundState.MINT_SUBMITTED],
    [InboundState.MINT_SUBMITTED,           InboundState.MINT_CONFIRMED],
    [InboundState.MINT_CONFIRMED,           InboundState.COMPLETED],
    [InboundState.FAILED,                   InboundState.REFUNDED],
    // FAILED is reachable from every non-terminal state
    [InboundState.QUOTE_CREATED,            InboundState.FAILED],
    [InboundState.DEPOSIT_ADDRESS_ASSIGNED, InboundState.FAILED],
    [InboundState.DEPOSIT_SEEN_MEMPOOL,     InboundState.FAILED],
    [InboundState.DEPOSIT_CONFIRMED,        InboundState.FAILED],
    [InboundState.DEPOSIT_FINALIZED,        InboundState.FAILED],
    [InboundState.MINT_AUTH_CREATED,        InboundState.FAILED],
    [InboundState.MINT_SUBMITTED,           InboundState.FAILED],
  ];

  for (const [from, to] of VALID) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransitionInbound(from, to)).toBe(true);
    });
  }

  // Negative cases: skip backwards, skip ahead, self-loop
  const INVALID: Array<[InboundState, InboundState]> = [
    [InboundState.QUOTE_CREATED,      InboundState.DEPOSIT_SEEN_MEMPOOL],  // skip ahead
    [InboundState.DEPOSIT_CONFIRMED,  InboundState.QUOTE_CREATED],         // backward
    [InboundState.MINT_CONFIRMED,     InboundState.FAILED],                // MINT_CONFIRMED can only → COMPLETED
    [InboundState.COMPLETED,          InboundState.FAILED],                // terminal
    [InboundState.COMPLETED,          InboundState.COMPLETED],             // self-loop
    [InboundState.REFUNDED,           InboundState.FAILED],                // terminal
    [InboundState.MINT_SUBMITTED,     InboundState.DEPOSIT_SEEN_MEMPOOL],  // backward
  ];

  for (const [from, to] of INVALID) {
    it(`rejects ${from} → ${to}`, () => {
      expect(canTransitionInbound(from, to)).toBe(false);
    });
  }
});

// ─── validNextStates ─────────────────────────────────────────────────────────

describe('validNextStates', () => {
  it('returns the same array as the transition table', () => {
    for (const s of ALL_STATES) {
      expect(validNextStates(s)).toEqual(INBOUND_TRANSITIONS[s]);
    }
  });
});

// ─── assertInboundTransition ─────────────────────────────────────────────────

describe('assertInboundTransition', () => {
  it('does not throw on valid transition', () => {
    expect(() =>
      assertInboundTransition(InboundState.QUOTE_CREATED, InboundState.DEPOSIT_ADDRESS_ASSIGNED),
    ).not.toThrow();
  });

  it('throws InboundTransitionError on invalid transition', () => {
    expect(() =>
      assertInboundTransition(InboundState.COMPLETED, InboundState.FAILED),
    ).toThrow(InboundTransitionError);
  });

  it('InboundTransitionError carries from/to fields', () => {
    let caught: InboundTransitionError | undefined;
    try {
      assertInboundTransition(InboundState.COMPLETED, InboundState.FAILED);
    } catch (e) {
      caught = e as InboundTransitionError;
    }
    expect(caught).toBeDefined();
    expect(caught!.from).toBe(InboundState.COMPLETED);
    expect(caught!.to).toBe(InboundState.FAILED);
  });

  it('error message names both states', () => {
    expect(() =>
      assertInboundTransition(InboundState.DEPOSIT_CONFIRMED, InboundState.QUOTE_CREATED),
    ).toThrow(/DEPOSIT_CONFIRMED.*QUOTE_CREATED/);
  });
});

// ─── Reachability: every state reachable from QUOTE_CREATED ──────────────────

describe('graph reachability', () => {
  function reachableFrom(start: InboundState): Set<InboundState> {
    const visited = new Set<InboundState>();
    const queue: InboundState[] = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of INBOUND_TRANSITIONS[node]) {
        queue.push(next);
      }
    }
    return visited;
  }

  it('every state is reachable from QUOTE_CREATED', () => {
    const reachable = reachableFrom(InboundState.QUOTE_CREATED);
    for (const s of ALL_STATES) {
      expect(reachable.has(s), `${s} is not reachable from QUOTE_CREATED`).toBe(true);
    }
  });

  it('COMPLETED and REFUNDED are reachable', () => {
    const reachable = reachableFrom(InboundState.QUOTE_CREATED);
    expect(reachable.has(InboundState.COMPLETED)).toBe(true);
    expect(reachable.has(InboundState.REFUNDED)).toBe(true);
  });
});
