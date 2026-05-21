/**
 * Unit tests for checkScanHalt — pure, side-effect-free, no DB / RPC.
 *
 * Covers spec v2 test #9 behavior (the alert decision logic). The watcher's
 * halt-state writes and the monitor's per-type-cooldown firing-once-per-
 * threshold-crossing are covered in the gnosis/event-watcher.test.ts
 * integration tests; this file is just the pure decision function.
 */

import { describe, it, expect } from 'vitest';
import { checkScanHalt } from '../../src/monitor/checks.js';

const TS = '2026-05-20T21:00:00.000Z';

describe('checkScanHalt', () => {
  it('returns no alert when haltBlock is null', () => {
    expect(checkScanHalt(null, 999, 10, null, null, TS)).toEqual([]);
  });

  it('returns no alert when haltBlock is empty string', () => {
    expect(checkScanHalt('', 999, 10, null, null, TS)).toEqual([]);
  });

  it('returns no alert when haltCount is below threshold', () => {
    expect(checkScanHalt('46280000', 9, 10, null, null, TS)).toEqual([]);
  });

  it('returns no alert when haltCount equals threshold − 1 (off-by-one guard)', () => {
    expect(checkScanHalt('46280000', 9, 10, null, null, TS)).toEqual([]);
  });

  it('fires alert when haltCount equals threshold exactly', () => {
    const alerts = checkScanHalt('46280000', 10, 10, null, null, TS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe('GNOSIS_SCAN_HALTED');
    expect(alerts[0]!.level).toBe('critical');
    expect(alerts[0]!.timestamp).toBe(TS);
  });

  it('fires alert when haltCount exceeds threshold (sustained halt)', () => {
    const alerts = checkScanHalt('46280000', 47, 10, null, null, TS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({
      haltBlock: '46280000',
      haltCount: 47,
      threshold: 10,
    });
  });

  it('includes failing withdrawalId in message when present', () => {
    const alerts = checkScanHalt('46280000', 10, 10, '4242', null, TS);
    expect(alerts[0]!.message).toContain('withdrawalId=4242');
    expect(alerts[0]!.data['failingWithdrawalId']).toBe('4242');
  });

  it('omits withdrawalId clause from message when not present', () => {
    const alerts = checkScanHalt('46280000', 10, 10, null, null, TS);
    expect(alerts[0]!.message).not.toContain('withdrawalId=');
    expect(alerts[0]!.data['failingWithdrawalId']).toBeNull();
  });

  it('includes last error in message when present', () => {
    const alerts = checkScanHalt(
      '46280000', 10, 10, null,
      'null value in column "sender_address" violates not-null constraint',
      TS,
    );
    expect(alerts[0]!.message).toContain('not-null constraint');
  });

  it('preserves block/count/threshold/withdrawalId/lastError in data payload', () => {
    const alerts = checkScanHalt(
      '46280000', 15, 10, '4242', 'sample error', TS,
    );
    expect(alerts[0]!.data).toEqual({
      haltBlock: '46280000',
      haltCount: 15,
      threshold: 10,
      failingWithdrawalId: '4242',
      lastError: 'sample error',
    });
  });
});
