/**
 * Replay-safety of the block handler, against a real Postgres.
 *
 * Startup catch-up re-runs blocks through handleBlock, and the three watchers
 * all process every block, so handling the same block twice (or two watchers
 * handling it at once) must change nothing the second time.
 *
 * Needs a THROWAWAY database with backend/migrations applied:
 *   WATCHER_TEST_DATABASE_URL=postgres://.../wbob_catchup_test npx vitest run
 * Skipped when the variable is unset. It deliberately does not fall back to
 * DATABASE_URL, so it can never run against the bridge's real database. Rows
 * are written with random addresses and txids and left in place (audit_events
 * is append-only).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { InboundState } from '@wbob/shared';
import { createBlockHandlers } from '../../src/deposits/block-handler.js';
import type { RpcBlock, RpcRawTransaction } from '../../src/rpc/types.js';

const URL = process.env['WATCHER_TEST_DATABASE_URL'];
const CONF = { minConfirmations: 3, finalConfirmations: 6 };
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

const rnd = (n: number) => randomBytes(n).toString('hex');

function payment(txid: string, address: string, value: number): RpcRawTransaction {
  return {
    txid, hash: txid, version: 1, size: 0, vsize: 0, weight: 0, locktime: 0, vin: [], hex: '',
    vout: [{ value, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash', address } }],
  };
}

function block(height: number, txs: RpcRawTransaction[] = []): RpcBlock {
  return { hash: `blk-${height}-${rnd(4)}`, height, confirmations: 1, tx: txs };
}

describe.skipIf(!URL)('handleBlock replay safety (real Postgres)', () => {
  let sql: postgres.Sql<{ bigint: bigint }>;
  let sql2: postgres.Sql<{ bigint: bigint }>; // a second "watcher"
  let hdIndex = 100_000 + Math.floor(Math.random() * 1_000_000);

  beforeAll(() => {
    sql  = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} });
    sql2 = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} });
  });
  afterAll(async () => { await sql.end(); await sql2.end(); });

  async function trackedAddress(): Promise<string> {
    const address = `regtest-${rnd(8)}`;
    await sql`
      INSERT INTO deposit_addresses (recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index)
      VALUES (${RECIPIENT}, 'dobbscoin-regtest', ${address}, ${hdIndex++})
    `;
    return address;
  }

  async function snapshot(txid: string) {
    const deposits = await sql<{ order_id: string; confirmations: number; state: string }[]>`
      SELECT sd.order_id, sd.confirmations, bo.state
      FROM source_deposits sd JOIN bridge_orders bo ON bo.id = sd.order_id
      WHERE sd.txid = ${txid}
    `;
    const ids = deposits.map((d) => d.order_id);
    const audits = ids.length === 0 ? [] : await sql<{ event_type: string; to_state: string }[]>`
      SELECT event_type, to_state FROM audit_events WHERE order_id IN ${sql(ids)} ORDER BY id
    `;
    return { deposits, audits };
  }

  it('A2 (persistent address): replaying the block ingests the deposit once', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF);
    const address = await trackedAddress();
    const txid = rnd(32);
    const b = block(5_000, [payment(txid, address, 10)]);

    expect(await handleBlock(b)).toBe(true);
    const first = await snapshot(txid);
    expect(first.deposits).toHaveLength(1);
    expect(first.deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);

    expect(await handleBlock(b)).toBe(true);
    expect(await snapshot(txid)).toEqual(first);
  });

  it('A2: two watchers handling the same block at once record one deposit, and neither reports a failure', async () => {
    const w1 = createBlockHandlers(sql, CONF);
    const w2 = createBlockHandlers(sql2, CONF);
    const address = await trackedAddress();
    const txid = rnd(32);
    const b = block(5_100, [payment(txid, address, 7)]);

    const results = await Promise.all([w1.handleBlock(b), w2.handleBlock(b)]);
    expect(results).toEqual([true, true]);
    const snap = await snapshot(txid);
    expect(snap.deposits).toHaveLength(1);
    expect(snap.audits.filter((a) => a.event_type === 'ORDER_CREATED')).toHaveLength(1);
  });

  it('A (quote-bound order): replaying the block does not re-transition or re-record', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF);
    const address = `quote-${rnd(8)}`;
    const [order] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', ${InboundState.DEPOSIT_ADDRESS_ASSIGNED}, ${RECIPIENT}, 500000000)
      RETURNING id
    `;
    await sql`
      INSERT INTO source_deposits (order_id, deposit_address, source_chain_name, hd_index)
      VALUES (${order!.id}, ${address}, 'dobbscoin-regtest', ${hdIndex++})
    `;
    const txid = rnd(32);
    const b = block(6_000, [payment(txid, address, 5)]);

    expect(await handleBlock(b)).toBe(true);
    const first = await snapshot(txid);
    expect(first.deposits).toHaveLength(1);
    expect(first.deposits[0]!.order_id).toBe(order!.id);
    expect(first.audits.map((a) => a.to_state)).toEqual([InboundState.DEPOSIT_SEEN_MEMPOOL]);

    expect(await handleBlock(b)).toBe(true);
    expect(await snapshot(txid)).toEqual(first);
  });

  it('B (confirmations): replaying older blocks never moves state or the confirmation count backwards', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF);
    const address = await trackedAddress();
    const txid = rnd(32);
    const H = 7_000;
    await handleBlock(block(H, [payment(txid, address, 3)]));   // 1 conf, SEEN_MEMPOOL
    await handleBlock(block(H + 3));                           // 4 confs → CONFIRMED
    const confirmed = await snapshot(txid);
    expect(confirmed.deposits[0]!.state).toBe(InboundState.DEPOSIT_CONFIRMED);
    expect(confirmed.deposits[0]!.confirmations).toBe(4);

    // Replay the blocks in between, as a catch-up after a crash would.
    for (const h of [H, H + 1, H + 2, H + 3]) {
      await handleBlock(block(h));
      expect(await snapshot(txid)).toEqual(confirmed);
    }

    await handleBlock(block(H + 5));                           // 6 confs → FINALIZED
    const final = await snapshot(txid);
    expect(final.deposits[0]!.state).toBe(InboundState.DEPOSIT_FINALIZED);
    for (const h of [H + 4, H + 5]) {
      await handleBlock(block(h));
      expect(await snapshot(txid)).toEqual(final);
    }
  });

  it('reports an incomplete block when a deposit fails to record', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF);
    const address = await trackedAddress();
    // Make the insert fail: a temporary trigger rejects this one order.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_reject_order() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.amount_sat = 424242 THEN RAISE EXCEPTION 'test: simulated insert failure'; END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_reject_order ON bridge_orders;
      CREATE TRIGGER test_reject_order BEFORE INSERT ON bridge_orders
        FOR EACH ROW EXECUTE FUNCTION test_reject_order();
    `);
    try {
      const b = block(8_000, [payment(rnd(32), address, 0.00424242)]);
      expect(await handleBlock(b)).toBe(false);
    } finally {
      await sql.unsafe('DROP TRIGGER test_reject_order ON bridge_orders; DROP FUNCTION test_reject_order();');
    }
  });

  it('ignores a zero-value output instead of failing on it forever', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF);
    const address = await trackedAddress();
    const txid = rnd(32);
    expect(await handleBlock(block(8_100, [payment(txid, address, 0)]))).toBe(true);
    expect((await snapshot(txid)).deposits).toHaveLength(0);
  });
});
