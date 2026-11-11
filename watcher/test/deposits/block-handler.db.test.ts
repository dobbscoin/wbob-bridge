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

// Node stub for tests that are not about reorgs: every tx is deep in the active
// chain, so min(heightConfs, nodeConfs) = heightConfs and behavior is as before.
const IN_CHAIN = async () => ({ confirmations: 1_000_000, blockHash: null });

function payment(txid: string, address: string, value: number): RpcRawTransaction {
  return {
    txid, hash: txid, version: 1, size: 0, vsize: 0, weight: 0, locktime: 0, vin: [], hex: '',
    vout: [{ value, n: 0, scriptPubKey: { asm: '', hex: '76a914' + '00'.repeat(20) + '88ac', type: 'pubkeyhash', address } }],
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
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
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
    const w1 = createBlockHandlers(sql, CONF, IN_CHAIN);
    const w2 = createBlockHandlers(sql2, CONF, IN_CHAIN);
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
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
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
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
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
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
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
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
    const address = await trackedAddress();
    const txid = rnd(32);
    expect(await handleBlock(block(8_100, [payment(txid, address, 0)]))).toBe(true);
    expect((await snapshot(txid)).deposits).toHaveLength(0);
  });

  // ── Reorg / double-spend: the node, not height arithmetic, decides ─────────
  // Each test drives a deposit into a block, then makes the node report the tx
  // as orphaned (0 confs) or unknown (null) and keeps feeding blocks. Before the
  // fix the recorded block_height kept counting and the deposit FINALIZED.

  function nodeStub() {
    const status = new Map<string, { confirmations: number; blockHash: string | null } | null>();
    const fn = async (txid: string) => (status.has(txid) ? status.get(txid)! : { confirmations: 1_000_000, blockHash: null });
    return { status, fn };
  }

  it('reorg: a deposit the node no longer has in the active chain never finalizes', async () => {
    const node = nodeStub();
    const { handleBlock } = createBlockHandlers(sql, CONF, node.fn);
    const address = await trackedAddress();
    const txid = rnd(32);
    await handleBlock(block(9_000, [payment(txid, address, 3)]));
    node.status.set(txid, { confirmations: 0, blockHash: 'orphaned' });   // block 9_000 reorged out
    for (let h = 9_001; h <= 9_020; h++) await handleBlock(block(h));
    const snap = await snapshot(txid);
    expect(snap.deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
    expect(snap.deposits[0]!.confirmations).toBe(0);
  });

  it('double-spend: an unknown tx (RPC -5) never finalizes', async () => {
    const node = nodeStub();
    const { handleBlock } = createBlockHandlers(sql, CONF, node.fn);
    const address = await trackedAddress();
    const txid = rnd(32);
    await handleBlock(block(9_100, [payment(txid, address, 3)]));
    node.status.set(txid, null);
    for (let h = 9_101; h <= 9_120; h++) await handleBlock(block(h));
    expect((await snapshot(txid)).deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  it('reorg after CONFIRMED: rolls back to SEEN_MEMPOOL with a TX_LEFT_ACTIVE_CHAIN audit, and does not re-confirm', async () => {
    const node = nodeStub();
    const { handleBlock } = createBlockHandlers(sql, CONF, node.fn);
    const address = await trackedAddress();
    const txid = rnd(32);
    await handleBlock(block(9_200, [payment(txid, address, 3)]));
    node.status.set(txid, { confirmations: 4, blockHash: null });
    await handleBlock(block(9_203));                                       // 4 confs → CONFIRMED
    expect((await snapshot(txid)).deposits[0]!.state).toBe(InboundState.DEPOSIT_CONFIRMED);
    node.status.set(txid, { confirmations: 0, blockHash: 'orphaned' });
    for (let h = 9_204; h <= 9_220; h++) await handleBlock(block(h));
    const snap = await snapshot(txid);
    expect(snap.deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
    expect(snap.audits.some((a) => a.event_type === 'TX_LEFT_ACTIVE_CHAIN')).toBe(true);
  });

  it('re-mined in another block: follows the node and finalizes on the node\'s count, not the stale height', async () => {
    const node = nodeStub();
    const { handleBlock } = createBlockHandlers(sql, CONF, node.fn);
    const address = await trackedAddress();
    const txid = rnd(32);
    await handleBlock(block(9_300, [payment(txid, address, 3)]));
    node.status.set(txid, { confirmations: 2, blockHash: 'newblock' });   // re-included lower down the new branch
    await handleBlock(block(9_310));                                       // height math says 11 → would FINALIZE
    expect((await snapshot(txid)).deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
    const [moved] = await sql<{ block_hash: string; confirmations: number }[]>`
      SELECT block_hash, confirmations FROM source_deposits WHERE txid = ${txid}
    `;
    expect(moved!.block_hash).toBe('newblock');
    expect(moved!.confirmations).toBe(2);                                  // node's count, not the stale 11
    node.status.set(txid, { confirmations: 6, blockHash: 'newblock' });
    await handleBlock(block(9_311));
    expect((await snapshot(txid)).deposits[0]!.state).toBe(InboundState.DEPOSIT_FINALIZED);
  });

  it('node unreachable: holds instead of advancing', async () => {
    let fail = false;
    const { handleBlock } = createBlockHandlers(sql, CONF, async () => {
      if (fail) throw new Error('rpc down');
      return { confirmations: 1_000_000, blockHash: null };
    });
    const address = await trackedAddress();
    const txid = rnd(32);
    await handleBlock(block(9_400, [payment(txid, address, 3)]));
    fail = true;
    for (let h = 9_401; h <= 9_410; h++) await handleBlock(block(h));
    expect((await snapshot(txid)).deposits[0]!.state).toBe(InboundState.DEPOSIT_SEEN_MEMPOOL);
  });

  // ── review round 11 (split): legacy quote orders vs persistent addresses ──
  it('a legacy quote order on a PERSISTENT address never claims its deposit: the address recipient gets it', async () => {
    const { handleBlock } = createBlockHandlers(sql, CONF, IN_CHAIN);
    const address = await trackedAddress();                         // belongs to RECIPIENT
    const thief = '0x6666666666666666666666666666666666666666';
    const [quote] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', ${InboundState.DEPOSIT_ADDRESS_ASSIGNED}, ${thief}, 500000000) RETURNING id`;
    await sql`INSERT INTO source_deposits (order_id, deposit_address, source_chain_name, hd_index)
              VALUES (${quote!.id}, ${address}, 'dobbscoin-regtest', ${hdIndex++})`;
    const txid = rnd(32);
    expect(await handleBlock(block(7_000, [payment(txid, address, 5)]))).toBe(true);
    const snap = await snapshot(txid);
    expect(snap.deposits).toHaveLength(1);
    expect(snap.deposits[0]!.order_id).not.toBe(quote!.id);          // not the quote order
    const [owner] = await sql<{ user_gnosis_address: string }[]>`SELECT user_gnosis_address FROM bridge_orders WHERE id = ${snap.deposits[0]!.order_id}`;
    expect(owner!.user_gnosis_address).toBe(RECIPIENT);
  });

  it('one output can be recorded as a deposit only once (migration 015)', async () => {
    const txid = rnd(32);
    const mk = async () => {
      const [o] = await sql<{ id: string }[]>`
        INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
        VALUES ('inbound', ${InboundState.DEPOSIT_SEEN_MEMPOOL}, ${RECIPIENT}, 1) RETURNING id`;
      await sql`INSERT INTO source_deposits (order_id, deposit_address, source_chain_name, hd_index, txid, vout, amount_sat)
                VALUES (${o!.id}, ${'x-' + rnd(4)}, 'dobbscoin-regtest', ${hdIndex++}, ${txid}, 0, 1)`;
    };
    await mk();
    await expect(mk()).rejects.toThrow(/uq_source_deposits_outpoint/);
  });
});

