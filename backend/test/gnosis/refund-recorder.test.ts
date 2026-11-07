import { describe, it, expect } from 'vitest';
import { RefundRecorder } from '../../src/gnosis/refund-recorder.js';
import type { BackendConfig } from '../../src/config.js';

const config = {
  executorPrivateKey: `0x${'1'.repeat(64)}`, gnosisRpcUrl: 'http://192.0.2.1:1', gnosisRpcUrls: ['http://192.0.2.1:1'],
  bridgeControllerAddress: '0x' + '7'.repeat(40), dobbscoinChainId: 1_000_001n,
} as unknown as BackendConfig;
const rec = { depositTxid: 'ab'.repeat(32), depositVout: 0, depositValueSat: 10n, refundedTotalSat: 4n };

function recorder() {
  const r = new RefundRecorder(config);
  const chain = { refunded: 0n, receipt: null as null | { status: 'success' | 'reverted' }, sends: 0 };
  (r as unknown as { reader: unknown }).reader = {
    readContract: async () => chain.refunded,
    getTransactionReceipt: async () => { if (!chain.receipt) throw new Error('not found'); return chain.receipt; },
  };
  (r as unknown as { writer: unknown }).writer = { writeContract: async () => { chain.sends++; return `0x${'c'.repeat(64)}`; } };
  return { r, chain };
}

describe('RefundRecorder never blocks on mining (review round 5 #7)', () => {
  it('sends once, returns false while pending, never resends, true once mined', async () => {
    const { r, chain } = recorder();
    expect(await r.ensureRecorded(rec)).toBe(false);
    expect(await r.ensureRecorded(rec)).toBe(false);
    expect(chain.sends).toBe(1);
    chain.receipt = { status: 'success' }; chain.refunded = 4n;
    expect(await r.ensureRecorded(rec)).toBe(true);
    expect(chain.sends).toBe(1);
  });
  it('reports a stuck tx once, still without resending', async () => {
    const { r, chain } = recorder();
    const stuck: string[] = [];
    r.stuckAfterMs = 0;
    r.onStuck = (_k, h) => stuck.push(h);
    await r.ensureRecorded(rec);
    await new Promise((x) => setTimeout(x, 2));
    await r.ensureRecorded(rec);
    await r.ensureRecorded(rec);
    expect(stuck).toHaveLength(1);
    expect(chain.sends).toBe(1);
  });
  it('throws when the tx reverted', async () => {
    const { r, chain } = recorder();
    await r.ensureRecorded(rec);
    chain.receipt = { status: 'reverted' };
    await expect(r.ensureRecorded(rec)).rejects.toThrow(/reverted/);
  });
});
