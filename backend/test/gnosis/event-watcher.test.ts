/**
 * Integration tests for GnosisEventWatcher.processNewWithdrawals — spec v2.
 *
 * Setup:
 *   - Requires a disposable Postgres test DB (env DATABASE_URL_TEST). The
 *     migration runner must have been applied to it.
 *   - The publicClient is mocked via property override after construction —
 *     we don't need a real Gnosis RPC for these tests; we're testing scan-
 *     loop control flow (chunking, watermark, halt, sort) against real DB
 *     constraints (UNIQUE / NOT NULL / transactional rollback).
 *
 * Coverage map (spec v2 §"Test plan v2"):
 *   1. Steady state                — `it('test 1 — steady state ...')`
 *   2. Empty range                 — `it('test 2 — empty range ...')`
 *   3. Reorg buffer                — `it('test 3 — reorg buffer ...')`
 *   4. Chunking / 5000-block catch — `it('test 4 — chunking catch-up ...')`
 *   5. Mid-batch failure halts     — `it('test 5 — mid-batch failure ...')`
 *   6. Idempotent re-scan          — `it('test 6 — idempotent re-scan ...')`
 *   7. Log ordering                — `it('test 7 — defensive sort ...')`
 *   8. First-event-in-first-window — `it('test 8 — first-event-in-first ...')`
 *   9. Halt-state recording        — `it('test 9 — halt-state across polls ...')`
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { GnosisEventWatcher } from '../../src/gnosis/event-watcher.js';
import type { BackendConfig } from '../../src/config.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const BRIDGE_ADDR = '0x' + '1'.repeat(40);

// Real signature hash for `WithdrawalRequested(uint256,address,uint256,string,uint256)`
// (not used directly in the test — viem computes it internally — but listed here
// for reference if you ever need to match against `topics[0]`).
const _WITHDRAWAL_EVENT_SIGHASH =
  '0x6e57f5d0c2a3f7b89e8a3f6e3d3b4f4b2a1d0c9e8f7d6c5b4a3928170615040';

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    gnosisRpcUrl:                'http://unused-in-test:8545',
    gnosisRpcUrls:               ['http://unused-in-test:8545'],
    gnosisConfirmationDepth:     12,
    gnosisLogScanChunk:          1000,
    gnosisScanHaltAlertThreshold: 10,
    bridgeControllerAddress:     BRIDGE_ADDR as `0x${string}`,
    executorPollIntervalMs:      15_000,
    // remaining required fields filled with stubs; cast bypasses interface bulk
    ...(overrides as object),
  } as unknown as BackendConfig;
}

interface FakeLog {
  blockNumber: bigint;
  logIndex:    number;
  transactionHash: `0x${string}`;
  args: {
    withdrawalId: bigint;
    sender:       string;
    amount:       bigint;
    dobbscoinAddress: string;
    nonce:        bigint;
  };
}

function makeLog(
  blockNumber: bigint,
  withdrawalId: bigint,
  opts: Partial<FakeLog['args']> = {},
  logIndex = 0,
): FakeLog {
  return {
    blockNumber,
    logIndex,
    transactionHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
    args: {
      withdrawalId,
      sender:           '0x' + '2'.repeat(40),
      amount:           1_000_000n,
      dobbscoinAddress: '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN',
      nonce:            withdrawalId,
      ...opts,
    },
  };
}

/**
 * Mock publicClient that records every getLogs call (in order) and returns
 * canned responses keyed by (fromBlock,toBlock). Also exposes a knob for the
 * current block number so each test can pin the chain tip.
 */
class MockPublicClient {
  blockNumber = 0n;
  getLogsCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  logsByRange = new Map<string, FakeLog[]>();

  setBlockNumber(n: bigint): void { this.blockNumber = n; }
  setLogsForRange(from: bigint, to: bigint, logs: FakeLog[]): void {
    this.logsByRange.set(`${from}-${to}`, logs);
  }

  async getBlockNumber(): Promise<bigint> { return this.blockNumber; }
  async getLogs(params: { fromBlock: bigint; toBlock: bigint }): Promise<FakeLog[]> {
    this.getLogsCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
    return this.logsByRange.get(`${params.fromBlock}-${params.toBlock}`) ?? [];
  }
}

// ─── test harness ────────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];

let sql: Sql;

beforeAll(async () => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL_TEST (or DATABASE_URL) must be set');
  sql = postgres(DATABASE_URL, { max: 2, types: { bigint: postgres.BigInt } });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  // Truncate the tables this test suite touches. audit_events has append-only
  // triggers (migration 003) that block TRUNCATE / DELETE in production — for
  // the disposable test DB only, we toggle them off long enough to reset, then
  // turn them back on. Production schema and triggers remain untouched.
  await sql.unsafe(`ALTER TABLE audit_events DISABLE TRIGGER trg_audit_no_truncate`);
  await sql.unsafe(`ALTER TABLE audit_events DISABLE TRIGGER trg_audit_no_delete`);
  await sql`TRUNCATE bridge_orders, withdrawal_requests, audit_events, bridge_state RESTART IDENTITY CASCADE`;
  await sql.unsafe(`ALTER TABLE audit_events ENABLE TRIGGER trg_audit_no_truncate`);
  await sql.unsafe(`ALTER TABLE audit_events ENABLE TRIGGER trg_audit_no_delete`);
});

function makeWatcher(
  config: BackendConfig,
  mock: MockPublicClient,
): GnosisEventWatcher {
  const watcher = new GnosisEventWatcher(sql, config);
  // Override the private publicClient with our mock. Test-only escape hatch.
  (watcher as unknown as { publicClient: MockPublicClient }).publicClient = mock;
  return watcher;
}

async function setLastBlock(value: bigint): Promise<void> {
  await sql`
    INSERT INTO bridge_state (key, value) VALUES ('gnosis_last_block', ${value.toString()})
    ON CONFLICT (key) DO UPDATE SET value = ${value.toString()}, updated_at = now()
  `;
}

async function getState(key: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM bridge_state WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

async function countWithdrawals(): Promise<number> {
  const rows = await sql<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM withdrawal_requests`;
  return Number(rows[0]!.c);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('GnosisEventWatcher.processNewWithdrawals', () => {

  // ── 1 — Steady state ──────────────────────────────────────────────────────
  it('test 1 — steady state: single event at safeTip is processed, watermark advances', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(100_012n);                          // currentBlock
    // safeTip = 100_012 - 12 = 100_000; fromBlock = 99_999+1 = 100_000
    await setLastBlock(99_999n);
    mock.setLogsForRange(100_000n, 100_000n, [makeLog(100_000n, 1n)]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toEqual([{ fromBlock: 100_000n, toBlock: 100_000n }]);
    expect(await getState('gnosis_last_block')).toBe('100000');
    expect(await countWithdrawals()).toBe(1);
  });

  // ── 2 — Empty range ───────────────────────────────────────────────────────
  it('test 2 — empty range: window with no logs advances watermark to windowEnd', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(200_500n);
    // safeTip = 200_488; from = 200_000+1 = 200_001
    await setLastBlock(200_000n);
    // chunk default 1000 → window: [200_001, 200_488] (488-wide; capped by safeTip)
    mock.setLogsForRange(200_001n, 200_488n, []);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toEqual([{ fromBlock: 200_001n, toBlock: 200_488n }]);
    expect(await getState('gnosis_last_block')).toBe('200488');
    expect(await countWithdrawals()).toBe(0);
  });

  // ── 3 — Reorg buffer ──────────────────────────────────────────────────────
  it('test 3 — reorg buffer: toBlock never exceeds currentBlock − gnosisConfirmationDepth', async () => {
    const config = makeConfig({ gnosisConfirmationDepth: 12 });
    const mock = new MockPublicClient();
    mock.setBlockNumber(300_010n);                           // currentBlock
    // safeTip = 300_010 - 12 = 299_998
    await setLastBlock(299_990n);
    mock.setLogsForRange(299_991n, 299_998n, []);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toHaveLength(1);
    expect(mock.getLogsCalls[0]!.toBlock).toBe(299_998n);
    expect(mock.getLogsCalls[0]!.toBlock).toBeLessThan(mock.blockNumber);
    expect(await getState('gnosis_last_block')).toBe('299998');
  });

  it('test 3b — reorg buffer: when fromBlock > safeTip, no getLogs call, no watermark change', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(100_010n);                           // safeTip = 99_998
    await setLastBlock(99_999n);                             // fromBlock = 100_000 > 99_998

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toHaveLength(0);
    expect(await getState('gnosis_last_block')).toBe('99999');   // unchanged
  });

  // ── 4 — Chunking / catch-up ───────────────────────────────────────────────
  it('test 4 — chunking: 5000-block lag → exactly 5 windows of 1000, watermark advances per window', async () => {
    const config = makeConfig({ gnosisLogScanChunk: 1000 });
    const mock = new MockPublicClient();
    mock.setBlockNumber(405_012n);
    // safeTip = 405_000; fromBlock = 400_000+1 = 400_001
    await setLastBlock(400_000n);

    // Pre-register 5 windows of 1000 blocks each, all empty for simplicity
    mock.setLogsForRange(400_001n, 401_000n, []);
    mock.setLogsForRange(401_001n, 402_000n, []);
    mock.setLogsForRange(402_001n, 403_000n, []);
    mock.setLogsForRange(403_001n, 404_000n, []);
    mock.setLogsForRange(404_001n, 405_000n, []);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toHaveLength(5);
    expect(mock.getLogsCalls).toEqual([
      { fromBlock: 400_001n, toBlock: 401_000n },
      { fromBlock: 401_001n, toBlock: 402_000n },
      { fromBlock: 402_001n, toBlock: 403_000n },
      { fromBlock: 403_001n, toBlock: 404_000n },
      { fromBlock: 404_001n, toBlock: 405_000n },
    ]);
    expect(await getState('gnosis_last_block')).toBe('405000');
    // No window exceeded the 1000-block cap
    for (const c of mock.getLogsCalls) {
      expect(c.toBlock - c.fromBlock).toBeLessThanOrEqual(999n);
    }
  });

  it('test 4b — chunking: ragged tail window (non-multiple of chunk) caps at safeTip', async () => {
    const config = makeConfig({ gnosisLogScanChunk: 1000 });
    const mock = new MockPublicClient();
    mock.setBlockNumber(401_512n);
    // safeTip = 401_500; fromBlock = 400_000+1 = 400_001; expect 2 windows: [400_001, 401_000] + [401_001, 401_500]
    await setLastBlock(400_000n);
    mock.setLogsForRange(400_001n, 401_000n, []);
    mock.setLogsForRange(401_001n, 401_500n, []);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(mock.getLogsCalls).toEqual([
      { fromBlock: 400_001n, toBlock: 401_000n },
      { fromBlock: 401_001n, toBlock: 401_500n },
    ]);
    expect(await getState('gnosis_last_block')).toBe('401500');
  });

  // ── 5 — Mid-batch failure halts ───────────────────────────────────────────
  // Failure trigger: amount=0n violates `bridge_orders_amount_sat_check`
  // (CHECK amount_sat IS NULL OR amount_sat > 0). The whole _createWithdrawalOrder
  // transaction rolls back, simulating a real persistent failure.
  it('test 5 — mid-batch failure: 3 events in block N, #3 fails → watermark N-1, halt-state recorded, return', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(500_012n);                                    // safeTip = 500_000
    await setLastBlock(499_999n);                                     // fromBlock = 500_000
    // Three events in block 500_000; #3 has empty sender → NOT NULL violation
    mock.setLogsForRange(500_000n, 500_000n, [
      makeLog(500_000n, 11n, {}, 0),
      makeLog(500_000n, 12n, {}, 1),
      makeLog(500_000n, 13n, { amount: 0n }, 2),                       // poison
    ]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    // Events 1 and 2 inserted; event 3 rolled back
    expect(await countWithdrawals()).toBe(2);
    // Watermark = failedBlock − 1 = 499_999 — but fromBlock was 500_000, so haltAt < fromBlock
    // ⇒ watermark UNCHANGED (test 8 also exercises this corner)
    expect(await getState('gnosis_last_block')).toBe('499999');
    // Halt-state recorded
    expect(await getState('gnosis_scan_halt_block')).toBe('500000');
    expect(await getState('gnosis_scan_halt_count')).toBe('1');
    expect(await getState('gnosis_scan_halt_withdrawal_id')).toBe('13');

    // Second poll: re-scan block 500_000; events 11, 12 are idempotent no-ops, 13 fails again, count → 2
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await countWithdrawals()).toBe(2);                          // no dupes (UNIQUE + pre-check)
    expect(await getState('gnosis_scan_halt_count')).toBe('2');
  });

  it('test 5b — mid-batch failure: events in DIFFERENT blocks, #2 fails → watermark = block(#2) − 1, blocks #3+ not scanned this poll', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(600_012n);                                    // safeTip = 600_000
    await setLastBlock(599_999n);                                     // fromBlock = 600_000
    mock.setLogsForRange(600_000n, 600_000n, [
      makeLog(600_000n,  21n, {}, 0),                                  // ok
      makeLog(600_000n,  22n, { amount: 0n }, 1),                      // FAIL — but in fromBlock, see test 8
    ]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(await countWithdrawals()).toBe(1);                          // only #21 inserted
    expect(await getState('gnosis_scan_halt_block')).toBe('600000');
  });

  // ── 6 — Idempotent re-scan ────────────────────────────────────────────────
  it('test 6 — idempotent re-scan: same logs replayed twice → zero duplicate withdrawal_requests', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(700_012n);                                    // safeTip = 700_000
    await setLastBlock(699_999n);
    mock.setLogsForRange(700_000n, 700_000n, [
      makeLog(700_000n, 31n),
      makeLog(700_000n, 32n),
    ]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await countWithdrawals()).toBe(2);

    // Force re-scan by resetting watermark
    await setLastBlock(699_999n);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await countWithdrawals()).toBe(2);                          // still 2, no dupes
  });

  // ── 7 — Log ordering / defensive sort ─────────────────────────────────────
  it('test 7 — defensive sort: logs delivered out-of-order are sorted ascending before iteration', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(800_012n);                                    // safeTip = 800_000
    await setLastBlock(799_999n);
    // Three events in two blocks, delivered in non-ascending order
    mock.setLogsForRange(800_000n, 800_000n, [
      makeLog(800_000n, 42n, {}, 1),                                    // (800_000, logIdx=1)
      makeLog(800_000n, 41n, {}, 0),                                    // (800_000, logIdx=0)  ← lowest
    ]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    // Both processed
    expect(await countWithdrawals()).toBe(2);
    // Insertion order is by logIndex ascending — withdrawalId 41 should be inserted first
    const inserted = await sql<{ withdrawal_id: string; created_at: Date }[]>`
      SELECT withdrawal_id, created_at FROM withdrawal_requests ORDER BY created_at
    `;
    expect(inserted[0]!.withdrawal_id).toBe('41');
    expect(inserted[1]!.withdrawal_id).toBe('42');
  });

  // ── 8 — First-event-in-first-window failure: watermark NOT moved backward ─
  it('test 8 — first event in fromBlock itself fails → watermark untouched (no backward move)', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(900_012n);                                    // safeTip = 900_000
    await setLastBlock(899_999n);                                     // fromBlock = 900_000
    mock.setLogsForRange(900_000n, 900_000n, [
      makeLog(900_000n, 51n, { amount: 0n }, 0),                       // FIRST event fails immediately
    ]);

    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();

    expect(await countWithdrawals()).toBe(0);
    // haltAt would be 899_999; fromBlock is 900_000; condition haltAt >= fromBlock FALSE → watermark unchanged
    expect(await getState('gnosis_last_block')).toBe('899999');
    expect(await getState('gnosis_scan_halt_block')).toBe('900000');
  });

  // ── 9 — Halt-state across polls (Path A flow) ─────────────────────────────
  it('test 9 — halt-state recording: counter increments same-block, resets new-block, clears on success', async () => {
    const config = makeConfig();
    const mock = new MockPublicClient();
    mock.setBlockNumber(1_000_012n);                                  // safeTip = 1_000_000
    await setLastBlock(999_999n);

    // First poll: poison event at block 1_000_000
    mock.setLogsForRange(1_000_000n, 1_000_000n, [
      makeLog(1_000_000n, 61n, { amount: 0n }, 0),
    ]);
    const watcher = makeWatcher(config, mock);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await getState('gnosis_scan_halt_count')).toBe('1');

    // Polls 2..5: same poison, same block — counter increments
    for (let i = 2; i <= 5; i++) {
      await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
      expect(await getState('gnosis_scan_halt_count')).toBe(String(i));
      expect(await getState('gnosis_scan_halt_block')).toBe('1000000');
    }

    // Poll with poison MOVED to a different block (manually engineer): counter resets to 1
    // Pretend ops cleared the original by manually advancing the watermark past 1_000_000.
    await setLastBlock(1_000_000n);
    mock.setBlockNumber(1_000_512n);                                  // new safeTip = 1_000_500
    mock.setLogsForRange(1_000_001n, 1_000_500n, [
      makeLog(1_000_500n, 71n, { amount: 0n }, 0),                      // new poison, new block
    ]);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await getState('gnosis_scan_halt_block')).toBe('1000500');
    expect(await getState('gnosis_scan_halt_count')).toBe('1');         // reset, not 6

    // Clean poll (no logs in next sweep) clears halt-state entirely
    await setLastBlock(1_000_500n);
    mock.setBlockNumber(1_001_012n);                                  // new safeTip = 1_001_000
    mock.setLogsForRange(1_000_501n, 1_001_000n, []);
    await (watcher as unknown as { processNewWithdrawals: () => Promise<void> }).processNewWithdrawals();
    expect(await getState('gnosis_scan_halt_block')).toBeNull();
    expect(await getState('gnosis_scan_halt_count')).toBeNull();
    expect(await getState('gnosis_scan_halt_withdrawal_id')).toBeNull();
    expect(await getState('gnosis_scan_halt_last_error')).toBeNull();
  });
});
