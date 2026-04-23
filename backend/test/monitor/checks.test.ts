/**
 * Unit tests for the Phase 8 solvency check functions.
 *
 * All functions under test are pure — no DB, no chain RPC, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { checkSolvency, checkStuckOrders, buildAlerts } from '../../src/monitor/checks.js';
import type { SolvencySnapshot } from '../../src/monitor/types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<SolvencySnapshot> = {}): SolvencySnapshot {
  return {
    checkedAt:        '2025-01-01T00:00:00.000Z',
    wBobSupplySat:    1_000_000_000n,  // 10 BOB
    utxoPoolSat:      1_200_000_000n,  // 12 BOB (120 % covered)
    pendingPayoutsSat: 100_000_000n,
    coverageRatio:    1.2,
    isSolvent:        true,
    stuckOrderCount:  0,
    ...overrides,
  };
}

const LOW_THRESHOLD = 500_000_000n; // 5 BOB

// ─── checkSolvency ────────────────────────────────────────────────────────────

describe('checkSolvency', () => {
  it('solvent when pool > supply', () => {
    const r = checkSolvency(1_000n, 1_200n);
    expect(r.isSolvent).toBe(true);
    expect(r.deficitSat).toBe(0n);
    expect(r.coverageRatio).toBeCloseTo(1.2);
  });

  it('solvent when pool === supply (exact 1:1)', () => {
    const r = checkSolvency(1_000n, 1_000n);
    expect(r.isSolvent).toBe(true);
    expect(r.deficitSat).toBe(0n);
    expect(r.coverageRatio).toBeCloseTo(1.0);
  });

  it('insolvent when pool < supply', () => {
    const r = checkSolvency(1_000n, 900n);
    expect(r.isSolvent).toBe(false);
    expect(r.deficitSat).toBe(100n);
    expect(r.coverageRatio).toBeCloseTo(0.9);
  });

  it('returns coverageRatio=1 when supply is zero', () => {
    const r = checkSolvency(0n, 0n);
    expect(r.isSolvent).toBe(true);
    expect(r.coverageRatio).toBe(1);
    expect(r.deficitSat).toBe(0n);
  });

  it('handles large satoshi values without overflow', () => {
    const supply = 21_000_000n * 100_000_000n;  // 21M BOB in sats
    const pool   = supply + 1n;
    const r = checkSolvency(supply, pool);
    expect(r.isSolvent).toBe(true);
    expect(r.deficitSat).toBe(0n);
  });

  it('deficit equals exact shortfall', () => {
    const r = checkSolvency(500n, 300n);
    expect(r.deficitSat).toBe(200n);
  });
});

// ─── checkStuckOrders ─────────────────────────────────────────────────────────

describe('checkStuckOrders', () => {
  const THRESHOLD_MS = 4 * 3_600_000; // 4 hours
  const NOW = new Date('2025-01-01T12:00:00Z').getTime();

  const orders = [
    { id: 'a', state: 'MINT_PENDING',   updatedAt: new Date('2025-01-01T07:59:59Z') }, // 4h0m1s ago → stuck
    { id: 'b', state: 'PAYOUT_QUEUED',  updatedAt: new Date('2025-01-01T08:00:01Z') }, // 3h59m59s ago → NOT stuck
    { id: 'c', state: 'DEPOSIT_CONFIRMED', updatedAt: new Date('2024-12-31T00:00:00Z') }, // very old → stuck
    { id: 'd', state: 'BURN_TX_SEEN',   updatedAt: new Date('2025-01-01T08:00:00Z') }, // exactly 4h → NOT stuck (>)
  ];

  it('returns IDs of orders past the threshold', () => {
    const stuck = checkStuckOrders(orders, THRESHOLD_MS, NOW);
    expect(stuck).toContain('a');
    expect(stuck).toContain('c');
    expect(stuck).not.toContain('b');
    expect(stuck).not.toContain('d');
  });

  it('returns empty array when all orders are recent', () => {
    const recent = [
      { id: 'x', state: 'MINT_PENDING', updatedAt: new Date(NOW - 1000) },
    ];
    expect(checkStuckOrders(recent, THRESHOLD_MS, NOW)).toHaveLength(0);
  });

  it('returns empty array when input is empty', () => {
    expect(checkStuckOrders([], THRESHOLD_MS, NOW)).toHaveLength(0);
  });

  it('marks all orders stuck when they all exceed threshold', () => {
    const stale = [
      { id: 'p', state: 'MINT_PENDING', updatedAt: new Date(NOW - THRESHOLD_MS - 1) },
      { id: 'q', state: 'BURN_TX_SEEN', updatedAt: new Date(NOW - THRESHOLD_MS - 1) },
    ];
    const stuck = checkStuckOrders(stale, THRESHOLD_MS, NOW);
    expect(stuck).toHaveLength(2);
  });
});

// ─── buildAlerts ─────────────────────────────────────────────────────────────

describe('buildAlerts', () => {
  it('no alerts when bridge is healthy', () => {
    const snap = makeSnapshot({
      isSolvent: true,
      stuckOrderCount: 0,
      utxoPoolSat: 2_000_000_000n,  // well above threshold
    });
    expect(buildAlerts(snap, true, LOW_THRESHOLD)).toHaveLength(0);
  });

  it('no alerts on first run (previouslySolvent=null) when healthy', () => {
    const snap = makeSnapshot({ isSolvent: true, stuckOrderCount: 0, utxoPoolSat: 2_000_000_000n });
    expect(buildAlerts(snap, null, LOW_THRESHOLD)).toHaveLength(0);
  });

  it('emits SOLVENCY_BREACH at critical level when insolvent', () => {
    const snap = makeSnapshot({
      isSolvent: false,
      wBobSupplySat: 1_000_000_000n,
      utxoPoolSat:   600_000_000n,  // above LOW_THRESHOLD but insolvent
      coverageRatio: 0.6,
    });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    const breach = alerts.find((a) => a.type === 'SOLVENCY_BREACH');
    expect(breach).toBeDefined();
    expect(breach!.level).toBe('critical');
  });

  it('emits SOLVENCY_RECOVERED (info) when transitioning false→true', () => {
    const snap = makeSnapshot({ isSolvent: true, utxoPoolSat: 2_000_000_000n });
    const alerts = buildAlerts(snap, false /* was breached */, LOW_THRESHOLD);
    const recovered = alerts.find((a) => a.type === 'SOLVENCY_RECOVERED');
    expect(recovered).toBeDefined();
    expect(recovered!.level).toBe('info');
  });

  it('does NOT emit SOLVENCY_RECOVERED when was already solvent', () => {
    const snap = makeSnapshot({ isSolvent: true, utxoPoolSat: 2_000_000_000n });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    expect(alerts.find((a) => a.type === 'SOLVENCY_RECOVERED')).toBeUndefined();
  });

  it('emits LOW_UTXO_POOL warning when pool below threshold', () => {
    const snap = makeSnapshot({
      isSolvent: true,
      wBobSupplySat: 100n,
      utxoPoolSat:   200_000_000n,  // below LOW_THRESHOLD (500M)
      coverageRatio: 2_000_000,
    });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    const low = alerts.find((a) => a.type === 'LOW_UTXO_POOL');
    expect(low).toBeDefined();
    expect(low!.level).toBe('warning');
  });

  it('does NOT emit LOW_UTXO_POOL when pool is above threshold', () => {
    const snap = makeSnapshot({ utxoPoolSat: 600_000_000n });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    expect(alerts.find((a) => a.type === 'LOW_UTXO_POOL')).toBeUndefined();
  });

  it('emits STUCK_ORDERS warning when stuckOrderCount > 0', () => {
    const snap = makeSnapshot({ stuckOrderCount: 3, utxoPoolSat: 2_000_000_000n });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    const stuck = alerts.find((a) => a.type === 'STUCK_ORDERS');
    expect(stuck).toBeDefined();
    expect(stuck!.level).toBe('warning');
    expect(stuck!.data['stuckOrderCount']).toBe(3);
  });

  it('can emit multiple alerts simultaneously', () => {
    const snap = makeSnapshot({
      isSolvent: false,
      wBobSupplySat: 1_000_000_000n,
      utxoPoolSat:   200_000_000n,  // insolvent AND below low threshold
      coverageRatio: 0.2,
      stuckOrderCount: 2,
    });
    const alerts = buildAlerts(snap, true, LOW_THRESHOLD);
    const types = alerts.map((a) => a.type);
    expect(types).toContain('SOLVENCY_BREACH');
    expect(types).toContain('LOW_UTXO_POOL');
    expect(types).toContain('STUCK_ORDERS');
  });

  it('SOLVENCY_BREACH data includes deficit as string', () => {
    const snap = makeSnapshot({
      isSolvent: false,
      wBobSupplySat: 1_000n,
      utxoPoolSat:   600n,
      coverageRatio: 0.6,
    });
    const alerts = buildAlerts(snap, null, LOW_THRESHOLD);
    const breach = alerts.find((a) => a.type === 'SOLVENCY_BREACH')!;
    expect(breach.data['deficitSat']).toBe('400');
  });

  it('does NOT emit SOLVENCY_BREACH when previously insolvent and still insolvent (same tick behavior)', () => {
    // SOLVENCY_BREACH fires every tick it's triggered — caller applies cooldown, not this fn.
    const snap = makeSnapshot({
      isSolvent: false,
      wBobSupplySat: 1_000n,
      utxoPoolSat:   600n,
      coverageRatio: 0.6,
    });
    const alerts = buildAlerts(snap, false /* was already breached */, LOW_THRESHOLD);
    // BREACH still fires (cooldown is the monitor's responsibility)
    expect(alerts.find((a) => a.type === 'SOLVENCY_BREACH')).toBeDefined();
    // RECOVERED should NOT fire while still insolvent
    expect(alerts.find((a) => a.type === 'SOLVENCY_RECOVERED')).toBeUndefined();
  });
});
