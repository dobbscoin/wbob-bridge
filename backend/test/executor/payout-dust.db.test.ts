/**
 * Dust / rejected-payout UTXO locking (2026-11-06), against a real Postgres.
 *
 *   PAYOUT_TEST_DATABASE_URL=postgres://.../wbob_payout_test npx vitest run test/executor/payout-dust
 *
 * Skipped when unset; never falls back to DATABASE_URL. Rows use random ids and
 * are left in place (audit_events is append-only).
 *
 * Before the fix: a 1-sat withdrawal was signed (largest coin reserved first),
 * the node rejected the broadcast as dust, the order went to MANUAL_REVIEW and
 * the reservation was never released, so N cheap withdrawals locked the N
 * largest coins.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { OutboundState } from '@wbob/shared';
import type { BackendConfig } from '../../src/config.js';
import { PayoutExecutor, belowPayoutMinimumReason, isDefiniteRejection } from '../../src/executor/payout-executor.js';
import { RpcCallError, RpcNetworkError } from '../../src/dobbscoin/rpc.js';
import { DobbscoinTxBuilder } from '../../src/dobbscoin/tx-builder.js';

const URL = process.env['PAYOUT_TEST_DATABASE_URL'];
const rnd = (n: number) => randomBytes(n).toString('hex');
const ADDR = '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN';

describe('isDefiniteRejection / belowPayoutMinimumReason (pure)', () => {
  const rej = (code: number, msg: string) => new RpcCallError('sendrawtransaction', code, msg);
  it('treats dust / fee / non-standard / malformed refusals as definite', () => {
    for (const e of [rej(-26, '64: dust'), rej(-26, '66: min relay fee not met'), rej(-26, '64: non-mandatory-script-verify-flag'), rej(-22, 'TX decode failed')]) {
      expect(isDefiniteRejection(e)).toBe(true);
    }
  });
  it('keeps the reservation when the inputs may be spent or the tx may be out there', () => {
    for (const e of [rej(-26, '258: txn-mempool-conflict'), rej(-26, 'bad-txns-inputs-spent'), rej(-25, 'Missing inputs'),
                     rej(-27, 'transaction already in block chain'), rej(-26, 'txn-already-known'),
                     rej(-25, ''),   // what a 0.10-era ATMP returns for conflict/missing inputs
                     rej(-26, '66: insufficient fee, rejecting replacement abc'), rej(-26, '64: too many potential replacements'),
                     rej(-26, '18: replacement-adds-unconfirmed'), rej(-26, '64: some-future-reason-we-do-not-know'),
                     new RpcNetworkError('sendrawtransaction', 'timeout'), new Error('boom'),
                     new RpcCallError('getrawtransaction', -26, '64: dust')]) {
      expect(isDefiniteRejection(e)).toBe(false);
    }
  });
  it('the tx builder itself refuses a dust recipient output, before selecting any coin', async () => {
    const b = new DobbscoinTxBuilder(HDKey.fromMasterSeed(randomBytes(32)).privateExtendedKey, 0);
    await expect(b.buildPayoutTx([], 546n, ADDR, ADDR, 10, {} as never)).rejects.toThrow(/at or under dust/);
  });

  it('parks at or under the minimum, pays above it', () => {
    expect(belowPayoutMinimumReason(1n, 100_000n)).toMatch(/at or under the payout minimum/);
    expect(belowPayoutMinimumReason(100_000n, 100_000n)).not.toBeNull();
    expect(belowPayoutMinimumReason(100_001n, 100_000n)).toBeNull();
  });
});

describe.skipIf(!URL)('PayoutExecutor dust / rejection handling (real Postgres)', () => {
  let sql: postgres.Sql<{ bigint: bigint }>;
  const config = {
    hdWalletXpriv: HDKey.fromMasterSeed(randomBytes(32)).privateExtendedKey,
    dobbscoinAddressVersion: 0,
    dobbscoinFeeRateSatPerVbyte: 10,
    payoutMinSat: 100_000n,
  } as unknown as BackendConfig;

  beforeAll(() => { sql = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });

  async function order(state: OutboundState, amountSat: bigint) {
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat)
      VALUES ('outbound', ${state}, ${'0x' + '2'.repeat(40)}, ${ADDR}, ${amountSat}) RETURNING id`;
    const [wr] = await sql<{ id: string }[]>`
      INSERT INTO withdrawal_requests (order_id, withdrawal_id, sender_address, dobbscoin_address, amount_sat, user_nonce)
      VALUES (${o!.id}, ${BigInt('0x' + rnd(8)).toString()}, ${'0x' + '2'.repeat(40)}, ${ADDR}, ${amountSat}, 0) RETURNING id`;
    return { orderId: o!.id, wrId: wr!.id };
  }

  async function utxo(orderId: string, amountSat: bigint, status = 'available', payoutId: string | null = null) {
    const txid = rnd(32);
    await sql`
      INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, status, spent_payout_id)
      VALUES (${orderId}, ${txid}, 0, ${amountSat}, ${ADDR}, 0, ${status}, ${payoutId})`;
    return txid;
  }

  /** A payout already signed, inputs reserved, waiting for broadcast. */
  async function signedPayout(amountSat: bigint) {
    const { orderId, wrId } = await order(OutboundState.PAYOUT_SIGNED, amountSat);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO payouts (withdrawal_request_id, dobbscoin_address, amount_sat, fee_sat)
      VALUES (${wrId}, ${ADDR}, ${amountSat}, 2260) RETURNING id`;
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_SIGNED', ${OutboundState.PAYOUT_QUEUED}, ${OutboundState.PAYOUT_SIGNED}, 'test',
              ${sql.json({ payoutId: p!.id, signedHex: 'deadbeef', changeSat: '0', changeAddress: null, changeIndex: null })})`;
    const big = await utxo(orderId, 5_000_000_000n, 'reserved', p!.id);
    return { orderId, payoutId: p!.id, big };
  }

  async function state(orderId: string) {
    const [r] = await sql<{ state: string }[]>`SELECT state FROM bridge_orders WHERE id = ${orderId}`;
    return r!.state;
  }
  async function utxoStatus(txid: string) {
    const [r] = await sql<{ status: string; spent_payout_id: string | null }[]>`
      SELECT status, spent_payout_id FROM bridge_utxos WHERE txid = ${txid}`;
    return r!;
  }

  function executor(sendRawTransaction: (hex: string) => Promise<string>) {
    const rpc = {
      sendRawTransaction,
      getRawTransactionHex: async () => { throw new Error('must not fetch inputs for an unpayable payout'); },
      getConfirmations: async () => -1,
    };
    return new PayoutExecutor(sql as never, rpc as never, config) as unknown as {
      processQueued(): Promise<void>; broadcastSigned(): Promise<void>;
    };
  }

  it('a dust-sized withdrawal is parked before any UTXO is selected, reserved or fetched', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 1n);
    const big = await utxo(orderId, 5_000_000_000n);
    await executor(async () => { throw new Error('must not broadcast'); }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    const [a] = await sql<{ error: string }[]>`
      SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/at or under the payout minimum/);
    const [p] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payouts p JOIN withdrawal_requests wr ON wr.id = p.withdrawal_request_id
      WHERE wr.order_id = ${orderId}`;
    expect(p!.n).toBe(0);
  });

  it('a definite node rejection releases the reserved inputs and parks the order', async () => {
    const { orderId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '64: dust'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    const [a] = await sql<{ released: string; byNode: string }[]>`
      SELECT metadata->'utxosReleased'->>0 AS released, metadata->>'rejectedByNode' AS "byNode"
      FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.released).toBe(`${big}:0`);
    expect(a!.byNode).toBe('true');
  });

  it('a mempool conflict keeps the reservation (the inputs may be spent elsewhere)', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '258: txn-mempool-conflict'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('a timeout keeps the reservation (the tx may have reached the network)', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcNetworkError('sendrawtransaction', 'timeout'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('a definite rejection on a REPEAT attempt keeps the reservation (an earlier send may be on peers)', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', 'PAYOUT_SIGNED', 'PAYOUT_SIGNED', 'test', ${sql.json({ payoutId, attempt: 1 })})`;
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '64: dust'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('only broadcasts the signed hex recorded for the CURRENT payout row, never an older one', async () => {
    const { orderId } = await signedPayout(200_000n);
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test',
              ${sql.json({ payoutId: '00000000-0000-0000-0000-000000000000', signedHex: 'stale0ld', changeSat: '0', changeAddress: null, changeIndex: null })})`;
    const sent: string[] = [];
    await executor(async (hex) => { sent.push(hex); return rnd(32); }).broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(sent).not.toContain('stale0ld');
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
  });

  it('a send the node ACCEPTED while the order was moved meanwhile still records the txid and marks inputs spent', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    const txid = rnd(32);
    await executor(async () => {
      // Another actor parks the order between our attempt record and the commit.
      await sql`UPDATE bridge_orders SET state = 'MANUAL_REVIEW' WHERE id = ${orderId}`;
      return txid;
    }).broadcastSigned();
    const [p] = await sql<{ txid: string | null }[]>`SELECT txid FROM payouts WHERE id = ${payoutId}`;
    expect(p!.txid).toBe(txid);
    expect((await utxoStatus(big)).status).toBe('spent');
    const [a] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_events WHERE order_id = ${orderId} AND event_type = 'PAYOUT_SENT_OUT_OF_STATE'`;
    expect(a!.n).toBe(1);
  });
});
