/**
 * Daily mint cap — the pure split arithmetic.
 *
 * Mirrors WBob._checkAndUpdateDailyLimit: a window older than 1 day is treated
 * as reset; the remaining allowance is limit − minted (bounded by MAX_SUPPLY
 * room); the bridge's own unexecuted mints are subtracted before a new deposit
 * is offered anything.
 */

import { describe, it, expect } from 'vitest';
import {
  DAY_SECONDS,
  availableCapacity,
  computeCapWindow,
  fmtBob,
  splitDeposit,
  sumOutstandingReservations,
  type MintCapChainState,
} from '../../src/executor/mint-capacity.js';

const BOB = 100_000_000n;
const LIMIT = 1_000_000n * BOB;                       // 1e14 sat
const DAY_START = 1_791_244_800n;                     // 2026-10-06T00:00:00Z (aligned)

function state(over: Partial<MintCapChainState> = {}): MintCapChainState {
  return {
    dailyMintLimit:   LIMIT,
    currentDayMinted: 0n,
    currentDayStart:  DAY_START,
    maxSupply:        21_000_000n * BOB,
    totalSupply:      0n,
    blockNumber:      42_000_000n,
    blockTimestamp:   DAY_START + 3_600n,
    ...over,
  };
}

describe('computeCapWindow', () => {
  it('inside the window: remaining = limit − minted, resets at window start + 1 day', () => {
    const w = computeCapWindow(state({ currentDayMinted: 276n * BOB }));
    expect(w.windowStale).toBe(false);
    expect(w.mintedTodaySat).toBe(276n * BOB);
    expect(w.remainingTodaySat).toBe(LIMIT - 276n * BOB);
    expect(w.resetsAtSec).toBe(DAY_START + DAY_SECONDS);
  });

  it('stale window (live case: 276 wBOB minted on 2026-08-29): treated as reset, full limit', () => {
    const aug29 = 1_787_961_600n; // 2026-08-29T00:00:00Z
    const now = DAY_START + 7_200n;
    const w = computeCapWindow(state({ currentDayMinted: 276n * BOB, currentDayStart: aug29, blockTimestamp: now }));
    expect(w.windowStale).toBe(true);
    expect(w.mintedTodaySat).toBe(0n);
    expect(w.remainingTodaySat).toBe(LIMIT);
    // the next mint aligns the window to today's 00:00 UTC
    expect(w.windowStartSec).toBe(DAY_START);
    expect(w.resetsAtSec).toBe(DAY_START + DAY_SECONDS);
  });

  it('exactly at currentDayStart + 1 day the window is stale (contract uses >=)', () => {
    const w = computeCapWindow(state({ currentDayMinted: LIMIT, blockTimestamp: DAY_START + DAY_SECONDS }));
    expect(w.windowStale).toBe(true);
    expect(w.remainingTodaySat).toBe(LIMIT);
  });

  it('one second before the reset the day is still spent', () => {
    const w = computeCapWindow(state({ currentDayMinted: LIMIT, blockTimestamp: DAY_START + DAY_SECONDS - 1n }));
    expect(w.windowStale).toBe(false);
    expect(w.remainingTodaySat).toBe(0n);
  });

  it('minted above the limit (limit lowered by admin) clamps to 0, never negative', () => {
    const w = computeCapWindow(state({ dailyMintLimit: 10n * BOB, currentDayMinted: 50n * BOB }));
    expect(w.remainingTodaySat).toBe(0n);
  });

  it('MAX_SUPPLY room bounds the remaining allowance', () => {
    const w = computeCapWindow(state({ maxSupply: 21_000_000n * BOB, totalSupply: 20_999_990n * BOB }));
    expect(w.remainingTodaySat).toBe(10n * BOB);
  });

  it('MAX_SUPPLY 0 means uncapped', () => {
    const w = computeCapWindow(state({ maxSupply: 0n, totalSupply: 10n ** 20n }));
    expect(w.remainingTodaySat).toBe(LIMIT);
  });
});

describe('availableCapacity — pending reservations', () => {
  it('subtracts the bridge’s unexecuted mints', () => {
    const w = computeCapWindow(state({ currentDayMinted: 100_000n * BOB }));
    expect(availableCapacity(w, 300_000n * BOB)).toBe(600_000n * BOB);
  });

  it('reservations past the remaining allowance leave 0, not negative', () => {
    const w = computeCapWindow(state({ currentDayMinted: 900_000n * BOB }));
    expect(availableCapacity(w, 200_000n * BOB)).toBe(0n);
  });

  it('a stale window still owes yesterday’s unexecuted reservations', () => {
    const w = computeCapWindow(state({ currentDayStart: DAY_START - 2n * DAY_SECONDS, currentDayMinted: LIMIT }));
    expect(w.windowStale).toBe(true);
    expect(availableCapacity(w, 250_000n * BOB)).toBe(750_000n * BOB);
  });
});

describe('sumOutstandingReservations', () => {
  const r = (amountSat: bigint, gnosisTxHash: string | null = null) => ({ amountSat, gnosisTxHash });

  it('counts unsigned and unsubmitted reservations', () => {
    expect(sumOutstandingReservations([r(5n), r(7n)], new Set())).toBe(12n);
  });

  it('skips a submitted mint already mined by the state block (it is inside currentDayMinted)', () => {
    const mined = new Set(['0xabc']);
    expect(sumOutstandingReservations([r(5n, '0xABC'), r(7n, '0xdef')], mined)).toBe(7n);
  });
});

describe('splitDeposit', () => {
  it('deposit under capacity mints whole', () => {
    expect(splitDeposit(808n * BOB, LIMIT)).toEqual({ mintSat: 808n * BOB, excessSat: 0n });
  });

  it('exactly the limit (1,000,000) on a fresh day mints fully, nothing refunded', () => {
    const cap = availableCapacity(computeCapWindow(state()), 0n);
    expect(splitDeposit(LIMIT, cap)).toEqual({ mintSat: LIMIT, excessSat: 0n });
  });

  it('1,000,000.00000001 mints 1,000,000 and leaves 1 sat excess', () => {
    const cap = availableCapacity(computeCapWindow(state()), 0n);
    expect(splitDeposit(LIMIT + 1n, cap)).toEqual({ mintSat: LIMIT, excessSat: 1n });
  });

  it('over remaining: mints what fits, excess is the rest', () => {
    const cap = availableCapacity(computeCapWindow(state({ currentDayMinted: 999_000n * BOB })), 0n);
    expect(splitDeposit(5_000n * BOB, cap)).toEqual({ mintSat: 1_000n * BOB, excessSat: 4_000n * BOB });
  });

  it('nothing left: mint 0, whole deposit is excess', () => {
    expect(splitDeposit(42n * BOB, 0n)).toEqual({ mintSat: 0n, excessSat: 42n * BOB });
  });

  it('negative capacity is treated as 0', () => {
    expect(splitDeposit(42n, -5n)).toEqual({ mintSat: 0n, excessSat: 42n });
  });

  it('a deposit larger than any single day mints the limit and refunds the rest', () => {
    const cap = availableCapacity(computeCapWindow(state()), 0n);
    expect(splitDeposit(2_500_000n * BOB, cap)).toEqual({ mintSat: LIMIT, excessSat: 1_500_000n * BOB });
  });

  it('rejects a non-positive deposit', () => {
    expect(() => splitDeposit(0n, LIMIT)).toThrow();
  });
});

describe('fmtBob', () => {
  it('formats sats as grouped BOB with trimmed zeros', () => {
    expect(fmtBob(123_456_789_000_00n)).toBe('123,456.789');
    expect(fmtBob(LIMIT)).toBe('1,000,000');
    expect(fmtBob(1n)).toBe('0.00000001');
  });
});
