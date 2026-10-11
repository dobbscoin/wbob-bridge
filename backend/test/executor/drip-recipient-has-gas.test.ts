/**
 * "can we deny a drip if the wallet already has xdai?" (btcbob, 2026-10)
 *
 * The recipient's native balance is read before sending. Enough gas → skipped
 * and recorded as recipient_has_gas, which keeps the one-ever drip available.
 * A failed read never withholds the drip.
 */

import { describe, it, expect } from 'vitest';
import { DripSender } from '../../src/executor/drip-sender.js';
import type { BackendConfig } from '../../src/config.js';

const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const DRIP = 50_000_000_000_000_000n; // 0.05 xDAI

function config(over: Partial<BackendConfig> = {}): BackendConfig {
  return {
    dripEnabled: true,
    dripHotWalletPrivateKey: `0x${'1'.repeat(64)}`,
    gnosisRpcUrl: 'http://192.0.2.1:8545',
    gnosisRpcUrls: ['http://192.0.2.1:8545'],
    dripAmountWei: DRIP,
    dripMinDepositSat: 1_000_000n,
    dripSkipIfRecipientBalanceWei: DRIP,
    ...(over as object),
  } as unknown as BackendConfig;
}

/** Minimal tagged-template fake of postgres.js holding one gas_drips row. */
function fakeSql(initial: { status: string }) {
  const row: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/^\s*SELECT status FROM gas_drips/.test(text)) return Promise.resolve([{ status: row['status'] }]);
    if (/UPDATE gas_drips/.test(text)) {
      writes.push(text);
      const set = text.slice(text.indexOf('SET'), text.indexOf('WHERE'));
      const cols = [...set.matchAll(/(\w+)\s*=\s*(\?|'[^']*'|now\(\))/g)];
      let v = 0;
      for (const [, col, rhs] of cols) {
        if (rhs === '?') row[col!] = values[v++];
        else if (rhs!.startsWith("'")) row[col!] = rhs!.slice(1, -1);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql: sql as never, row, writes };
}

function sender(db: ReturnType<typeof fakeSql>, balance: () => Promise<bigint>) {
  const d = new DripSender(db.sql, config());
  const sent: unknown[] = [];
  (d as unknown as { publicClient: unknown }).publicClient = {
    getBalance: async ({ address }: { address: string }) =>
      address.toLowerCase() === RECIPIENT.toLowerCase() ? balance() : 10n ** 21n, // drip wallet is full
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  (d as unknown as { walletClient: unknown }).walletClient = {
    sendTransaction: async (tx: unknown) => { sent.push(tx); return `0x${'ab'.repeat(32)}`; },
  };
  return { d, sent };
}

describe('drip skipped when the recipient already has xDAI', () => {
  it('balance >= threshold → recipient_has_gas, nothing sent, drip still available', async () => {
    const db = fakeSql({ status: 'opted_in' });
    const { d, sent } = sender(db, async () => 2n * DRIP);
    const r = await d.sendDripIfEligible(RECIPIENT, 'order-1', 10_000_000n);
    expect(r.outcome).toBe('recipient_has_gas');
    expect(sent).toHaveLength(0);
    expect(db.row['status']).toBe('recipient_has_gas');
    expect(db.row['recipient_balance_wei']).toBe(String(2n * DRIP));

    // Later mint, wallet has run dry → this time the drip goes out.
    const later = sender(db, async () => 0n);
    const r2 = await later.d.sendDripIfEligible(RECIPIENT, 'order-2', 10_000_000n);
    expect(r2.outcome).toBe('sent');
    expect(later.sent).toHaveLength(1);
    expect(db.row['status']).toBe('sent');
  });

  it('exactly the threshold counts as having gas', async () => {
    const db = fakeSql({ status: 'opted_in' });
    const { d, sent } = sender(db, async () => DRIP);
    expect((await d.sendDripIfEligible(RECIPIENT, 'o', 10_000_000n)).outcome).toBe('recipient_has_gas');
    expect(sent).toHaveLength(0);
  });

  it('low balance → drip sent as before', async () => {
    const db = fakeSql({ status: 'opted_in' });
    const { d, sent } = sender(db, async () => DRIP - 1n);
    const r = await d.sendDripIfEligible(RECIPIENT, 'o', 10_000_000n);
    expect(r.outcome).toBe('sent');
    expect(sent).toEqual([{ to: RECIPIENT, value: DRIP }]);
  });

  it('balance read error → drip sent anyway (never withheld on a failed read)', async () => {
    const db = fakeSql({ status: 'opted_in' });
    const { d, sent } = sender(db, async () => { throw new Error('rpc down'); });
    const r = await d.sendDripIfEligible(RECIPIENT, 'o', 10_000_000n);
    expect(r.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('a drip already sent is never re-sent, whatever the balance', async () => {
    const db = fakeSql({ status: 'sent' });
    const { d, sent } = sender(db, async () => 0n);
    expect((await d.sendDripIfEligible(RECIPIENT, 'o', 10_000_000n)).outcome).toBe('already_done');
    expect(sent).toHaveLength(0);
  });
});
