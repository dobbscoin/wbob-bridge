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
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { OutboundState } from '@wbob/shared';
import type { BackendConfig } from '../../src/config.js';
import { PayoutExecutor, belowPayoutMinimumReason, isDefiniteRejection } from '../../src/executor/payout-executor.js';
import { RpcCallError, RpcNetworkError } from '../../src/dobbscoin/rpc.js';
import type { BurnVerifierLike, BurnClaim } from '../../src/gnosis/burn-verifier.js';
import { DobbscoinTxBuilder, txidFromRawHex, txInputsFromRawHex } from '../../src/dobbscoin/tx-builder.js';

const URL = process.env['PAYOUT_TEST_DATABASE_URL'];
const rnd = (n: number) => randomBytes(n).toString('hex');
const ADDR = '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN';
const ROOT = HDKey.fromMasterSeed(randomBytes(32));
const DEADBEEF_TXID = txidFromRawHex('deadbeef');

/** A minimal prev tx paying `amountSat` to the bridge's deposit key m/0/0 (so the builder can really sign). */
function prevTxPayingDepositKey0(amountSat: bigint): string {
  const pub = ROOT.derive('m/0/0').publicKey!;
  const pkh = ripemd160(sha256(pub));
  const script = Buffer.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const amt = Buffer.alloc(8); amt.writeBigInt64LE(amountSat, 0);
  return Buffer.concat([
    Buffer.from('01000000', 'hex'), Buffer.from([1]), Buffer.alloc(32, 0), Buffer.alloc(4, 0), Buffer.from([0]),
    Buffer.alloc(4, 0xff), Buffer.from([1]), amt, Buffer.from([script.length]), script, Buffer.alloc(4, 0),
  ]).toString('hex');
}

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
    hdWalletXpriv: ROOT.privateExtendedKey,
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

  function executor(
    sendRawTransaction: (hex: string) => Promise<string>,
    more: { getConfirmations?: (txid: string) => Promise<number>; getRawTransactionHex?: (txid: string) => Promise<string>;
            isInMempool?: (txid: string) => Promise<boolean>;
            burn?: BurnVerifierLike } = {},
  ) {
    const rpc = {
      sendRawTransaction,
      getRawTransactionHex: more.getRawTransactionHex ?? (async () => { throw new Error('must not fetch inputs for an unpayable payout'); }),
      getConfirmations: more.getConfirmations ?? (async () => -1),
      isInMempool: more.isInMempool ?? (async () => false),
    };
    const burn = more.burn ?? { verify: async () => ({ ok: true as const }) };
    return new PayoutExecutor(sql as never, rpc as never, config, null, burn) as unknown as {
      processQueued(): Promise<void>; broadcastSigned(): Promise<void>; confirmBroadcast(): Promise<void>;
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

  it('a timeout with the tx unknown to the node keeps the reservation and retries the same tx', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcNetworkError('sendrawtransaction', 'timeout'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;   // keep later tests' broadcasts clean
  });

  it('a definite rejection on a REPEAT attempt keeps the reservation (an earlier send may be on peers)', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', 'PAYOUT_SIGNED', 'PAYOUT_SIGNED', 'test', ${sql.json({ payoutId, txid: txidFromRawHex('deadbeef'), attempt: 1 })})`;
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

  // ── Lost acknowledgements (2026-11-06) ──────────────────────────────────────

  async function payoutTxid(payoutId: string) {
    const [r] = await sql<{ txid: string | null }[]>`SELECT txid FROM payouts WHERE id = ${payoutId}`;
    return r!.txid;
  }

  it('lost ack: send times out but the node HAS the tx → recorded as broadcast, inputs spent', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcNetworkError('sendrawtransaction', 'timeout'); },
      { getConfirmations: async (t) => (t === DEADBEEF_TXID ? 0 : -1), isInMempool: async (t) => t === DEADBEEF_TXID }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
    expect(await payoutTxid(payoutId)).toBe(DEADBEEF_TXID);
    expect((await utxoStatus(big)).status).toBe('spent');
    const [a] = await sql<{ ack: string }[]>`
      SELECT metadata->>'ackLost' AS ack FROM audit_events WHERE order_id = ${orderId} AND to_state = 'PAYOUT_BROADCAST'`;
    expect(a!.ack).toBe('true');
  });

  it('lost ack: an earlier send already got it mined (-27) → recorded as broadcast', async () => {
    const { orderId, payoutId } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -27, 'transaction already in block chain'); },
      { getConfirmations: async () => { throw new RpcNetworkError('getrawtransaction', 'down'); } }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
    expect(await payoutTxid(payoutId)).toBe(DEADBEEF_TXID);
  });

  it('transient failures re-send the same tx, then park after the attempt limit with inputs held', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    const sent: string[] = [];
    const ex = executor(async (h) => { sent.push(h); throw new RpcNetworkError('sendrawtransaction', 'timeout'); });
    for (let i = 0; i < 239; i++) await ex.broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    await ex.broadcastSigned();                                   // 240th attempt
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(new Set(sent.filter((h) => h === 'deadbeef')).size).toBe(1);   // only ever the same tx
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('operator retry while the coins are held re-sends the SAME signed tx (no re-sign)', async () => {
    const { orderId, payoutId } = await signedPayout(200_000n);
    await sql`UPDATE bridge_orders SET state = 'PAYOUT_QUEUED' WHERE id = ${orderId}`;   // operator re-queue
    const sent: string[] = [];
    const ex = executor(async (h) => { sent.push(h); return DEADBEEF_TXID; });
    await ex.processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    await ex.broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
    expect(await payoutTxid(payoutId)).toBe(DEADBEEF_TXID);
  });

  it('operator retry of a payout that already went out is refused (no second payment)', async () => {
    const { orderId, payoutId } = await signedPayout(200_000n);
    await sql`UPDATE payouts SET txid = ${DEADBEEF_TXID} WHERE id = ${payoutId}`;
    await sql`UPDATE bridge_orders SET state = 'PAYOUT_QUEUED' WHERE id = ${orderId}`;
    await executor(async () => { throw new Error('must not send'); }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`
      SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW' ORDER BY id DESC LIMIT 1`;
    expect(a!.error).toMatch(/retry refused/);
  });

  it('operator retry after the coins were released re-signs under the same payout row and sends ONLY the new tx', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    // The node refused it outright on the first attempt: inputs released, order parked.
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '66: min relay fee not met'); }).broadcastSigned();
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    // Make the pool hold exactly one real, signable coin.
    await sql`UPDATE bridge_utxos SET status = 'spent' WHERE status = 'available'`;
    const prevHex = prevTxPayingDepositKey0(5_000_000_000n);
    const coin = txidFromRawHex(prevHex);
    await sql`
      INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, status)
      VALUES (${orderId}, ${coin}, 0, 5000000000, ${ADDR}, 0, 'available')`;
    const recipient = new DobbscoinTxBuilder(ROOT.privateExtendedKey, 0).deriveChangeAddress(99);   // a decodable address
    await sql`UPDATE bridge_orders SET state = 'PAYOUT_QUEUED', user_dobbscoin_address = ${recipient} WHERE id = ${orderId}`;
    await sql`UPDATE withdrawal_requests SET dobbscoin_address = ${recipient} WHERE order_id = ${orderId}`;   // as ingested

    const sent: string[] = [];
    const ex = executor(async (h) => { sent.push(h); return txidFromRawHex(h); },
      { getRawTransactionHex: async (t) => { if (t !== coin) throw new Error('unknown prev'); return prevHex; } });
    await ex.processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    expect(await utxoStatus(coin)).toEqual({ status: 'reserved', spent_payout_id: payoutId });   // same payout row
    await ex.broadcastSigned();
    expect(sent).not.toContain('deadbeef');                              // never the old, released tx
    expect(sent).toHaveLength(1);
    expect(await payoutTxid(payoutId)).toBe(txidFromRawHex(sent[0]!));
    expect(txInputsFromRawHex(sent[0]!)).toEqual([{ txid: coin, vout: 0 }]);   // parser vs a real signed tx
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
  });

  it('a broadcast payout the node has forgotten is re-sent as the same tx; it parks only after refusals persist', async () => {
    const { orderId, payoutId } = await signedPayout(200_000n);
    await sql`UPDATE payouts SET txid = ${DEADBEEF_TXID}, broadcast_at = now() - interval '1 hour' WHERE id = ${payoutId}`;
    await sql`UPDATE bridge_orders SET state = 'PAYOUT_BROADCAST' WHERE id = ${orderId}`;
    const sent: string[] = [];
    let send: (h: string) => Promise<string> = async (h) => { sent.push(h); return DEADBEEF_TXID; };
    const ex = executor((h) => send(h));
    const unthrottle = () => { const st = (ex as unknown as { resendState: Map<string, { last: number }> }).resendState.get(payoutId); if (st) st.last = 0; };
    await ex.confirmBroadcast();
    expect(sent).toContain('deadbeef');
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);

    send = async () => { throw new RpcCallError('sendrawtransaction', -25, 'Missing inputs'); };
    for (let i = 0; i < 2; i++) { unthrottle(); await ex.confirmBroadcast(); }
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);   // a forgotten parent may come back first
    unthrottle(); await ex.confirmBroadcast();                          // 3rd consecutive refusal
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
  });

  it('a LEGACY attempt row (no txid, written before this fix) also blocks auto-release', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', 'PAYOUT_SIGNED', 'PAYOUT_SIGNED', 'test', ${sql.json({ payoutId, attempt: 1 })})`;
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '64: dust'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('an operator-retried payout never auto-releases, even on a first attempt of that tx', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'RETRY_SAME_TX', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ payoutId })})`;
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '66: mempool min fee not met'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
  });

  it('a definite refusal of a tx the node nevertheless HAS is recorded as broadcast, not released', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '66: min relay fee not met'); },
      { getConfirmations: async (t) => (t === DEADBEEF_TXID ? 0 : -1), isInMempool: async (t) => t === DEADBEEF_TXID }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_BROADCAST);
    expect(await payoutTxid(payoutId)).toBe(DEADBEEF_TXID);
    expect((await utxoStatus(big)).status).toBe('spent');
  });

  it('a tx only in a STALE block (confirmations 0, not in the mempool) is NOT recorded as broadcast', async () => {
    const { orderId, payoutId, big } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -25, 'Missing inputs'); },
      { getConfirmations: async () => 0, isInMempool: async () => false }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);      // -25 is retried, never "broadcast"
    expect(await payoutTxid(payoutId)).toBeNull();
    expect(await utxoStatus(big)).toEqual({ status: 'reserved', spent_payout_id: payoutId });
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;   // keep later tests clean
  });

  it('a refusal whose node lookup fails waits a poll, then still auto-releases (the refusal is recorded)', async () => {
    const { orderId, big } = await signedPayout(200_000n);
    let lookupDown = true;
    const ex = executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '64: dust'); },
      { getConfirmations: async () => { if (lookupDown) throw new RpcNetworkError('getrawtransaction', 'down'); return -1; } });
    await ex.broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    lookupDown = false;
    await ex.broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
  });

  it('too-long-mempool-chain is retried with the same tx, not parked', async () => {
    const { orderId } = await signedPayout(200_000n);
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '64: too-long-mempool-chain'); }).broadcastSigned();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;   // keep later tests clean
  });

  // ── Review round 5 #1: the burn must back the payout ─────────────────────
  it('a payout the chain does not back is parked before any coin is touched', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const big = await utxo(orderId, 5_000_000_000n);
    const seen: BurnClaim[] = [];
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async (c) => { seen.push(c); return { ok: false, defer: false, reason: 'burn check failed: amount on-chain 1 != payout amount 200000' }; } },
    }).processQueued();
    expect(seen[0]!.amountSat).toBe(200_000n);
    expect(seen[0]!.dobbscoinAddress).toBe(ADDR);
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    const [p] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payouts p JOIN withdrawal_requests wr ON wr.id = p.withdrawal_request_id WHERE wr.order_id = ${orderId}`;
    expect(p!.n).toBe(0);
  });

  it('an unreachable node or a shallow burn only defers: the order stays queued, nothing is signed', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const big = await utxo(orderId, 5_000_000_000n);
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => ({ ok: false, defer: true, reason: 'Gnosis node unreachable' }) },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  it('an order whose amount was raised after ingest (order != withdrawal row) is parked without asking the chain', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`UPDATE bridge_orders SET amount_sat = 900000000 WHERE id = ${orderId}`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
  });
});
