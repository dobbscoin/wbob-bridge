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
// A minimal legacy tx that parses (one input ee..ee:0, no outputs): round 10 parks on signed data that doesn't.
const OLD_HEX = '01000000' + '01' + 'ee'.repeat(32) + '00000000' + '00' + 'ffffffff' + '00' + '00000000';
const DEADBEEF_TXID = txidFromRawHex(OLD_HEX);
/** A minimal legacy tx spending txid:vout (no outputs): an earlier signed attempt, for the conflict rule. */
function minimalSpend(txid: string, vout: number): string {
  const v = Buffer.alloc(4); v.writeUInt32LE(vout, 0);
  return '01000000' + '01' + Buffer.from(txid, 'hex').reverse().toString('hex') + v.toString('hex') + '00' + 'ffffffff' + '00' + '00000000';
}

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
    const wid = BigInt('0x' + rnd(8)).toString();
    const [wr] = await sql<{ id: string }[]>`
      INSERT INTO withdrawal_requests (order_id, withdrawal_id, sender_address, dobbscoin_address, amount_sat, user_nonce)
      VALUES (${o!.id}, ${wid}, ${'0x' + '2'.repeat(40)}, ${ADDR}, ${amountSat}, 0) RETURNING id`;
    // as the gnosis watcher writes it (review round 10 #1: only such an order may be paid)
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${o!.id}, 'ORDER_CREATED', 'WITHDRAW_REQUEST_CREATED', 'BURN_TX_SEEN', 'gnosis-watcher', ${sql.json({ withdrawalId: wid })})`;
    return { orderId: o!.id, wrId: wr!.id, wid };
  }

  async function utxo(orderId: string, amountSat: bigint, status = 'available', payoutId: string | null = null) {
    const txid = rnd(32);
    await sql`
      INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, status, spent_payout_id)
      VALUES (${orderId}, ${txid}, 0, ${amountSat}, ${ADDR}, 0, ${status}, ${payoutId})`;
    return txid;
  }

  /** A payout already signed, inputs reserved, waiting for broadcast. */
  async function signedPayout(amountSat: bigint, signedHex: string = OLD_HEX) {
    const { orderId, wrId } = await order(OutboundState.PAYOUT_SIGNED, amountSat);
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO payouts (withdrawal_request_id, dobbscoin_address, amount_sat, fee_sat)
      VALUES (${wrId}, ${ADDR}, ${amountSat}, 2260) RETURNING id`;
    await sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, 'PAYOUT_SIGNED', ${OutboundState.PAYOUT_QUEUED}, ${OutboundState.PAYOUT_SIGNED}, 'test',
              ${sql.json({ payoutId: p!.id, signedHex, changeSat: '0', changeAddress: null, changeIndex: null })})`;
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
            isUnspent?: (txid: string, vout: number) => Promise<boolean>;
            getRawTransactionVerbose?: (txid: string) => Promise<unknown>;
            burn?: BurnVerifierLike } = {},
  ) {
    const rpc = {
      sendRawTransaction,
      getRawTransactionHex: more.getRawTransactionHex ?? (async () => { throw new Error('must not fetch inputs for an unpayable payout'); }),
      getConfirmations: more.getConfirmations ?? (async () => -1),
      isInMempool: more.isInMempool ?? (async () => false),
      isUnspent: more.isUnspent ?? (async () => true),
      getRawTransactionVerbose: more.getRawTransactionVerbose ??
        (async () => { throw new RpcCallError('getrawtransaction', -5, 'No such mempool or blockchain transaction'); }),
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
      VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', 'PAYOUT_SIGNED', 'PAYOUT_SIGNED', 'test', ${sql.json({ payoutId, txid: txidFromRawHex(OLD_HEX), attempt: 1 })})`;
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
    expect(sent).toContain(OLD_HEX);
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
    expect(new Set(sent.filter((h) => h === OLD_HEX)).size).toBe(1);   // only ever the same tx
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
    expect(sent).toContain(OLD_HEX);
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
    const prevHex = prevTxPayingDepositKey0(5_000_000_000n);
    const coin = txidFromRawHex(prevHex);
    // The first attempt spent `coin` (round 11: a re-sign must spend one of its coins again).
    const first = minimalSpend(coin, 0);
    const { orderId, payoutId, big } = await signedPayout(200_000n, first);
    // The node refused it outright on the first attempt: inputs released, order parked.
    await executor(async () => { throw new RpcCallError('sendrawtransaction', -26, '66: min relay fee not met'); }).broadcastSigned();
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    // Make the pool hold exactly one real, signable coin.
    await sql`UPDATE bridge_utxos SET status = 'spent' WHERE status = 'available'`;
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
    expect(sent).not.toContain(first);                                // never the old, released tx
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
    expect(sent).toContain(OLD_HEX);
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

  // ── Review round 6 #1: one burn is paid once, whatever the DB says ───────
  it('a burn already paid is never paid again, even after its payout rows are erased and the order re-created', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const [w] = await sql<{ withdrawal_id: string }[]>`SELECT withdrawal_id::text FROM withdrawal_requests WHERE order_id = ${orderId}`;
    const paidTx = rnd(32);
    // The first payment, as the audit trail recorded it (this row can't be erased).
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'ORDER_CREATED', 'WITHDRAW_REQUEST_CREATED', 'BURN_TX_SEEN', 'test', ${sql.json({ withdrawalId: w!.withdrawal_id })})`;
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: paidTx, payoutId: 'gone' })})`;
    // Attacker: drop the withdrawal row, re-create the order for the same burn, queue it.
    await sql`UPDATE withdrawal_requests SET withdrawal_id = withdrawal_id + 1000000000000 WHERE order_id = ${orderId}`;
    await sql`UPDATE bridge_orders SET state = 'COMPLETED' WHERE id = ${orderId}`;
    const [o2] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat)
      VALUES ('outbound', 'PAYOUT_QUEUED', ${'0x' + '2'.repeat(40)}, ${ADDR}, 200000) RETURNING id`;
    await sql`INSERT INTO withdrawal_requests (order_id, withdrawal_id, sender_address, dobbscoin_address, amount_sat, user_nonce)
              VALUES (${o2!.id}, ${w!.withdrawal_id}, ${'0x' + '2'.repeat(40)}, ${ADDR}, 200000, 0)`;
    // (round 10) to be payable at all it needs its own ORDER_CREATED: forge one, as an attacker would
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${o2!.id}, 'ORDER_CREATED', 'WITHDRAW_REQUEST_CREATED', 'BURN_TX_SEEN', 'gnosis-watcher', ${sql.json({ withdrawalId: w!.withdrawal_id })})`;
    const big = await utxo(o2!.id, 5_000_000_000n);
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async (t) => (t === paidTx ? 7 : -1),
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(o2!.id)).toBe(OutboundState.MANUAL_REVIEW);
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    const [a] = await sql<{ error: string }[]>`
      SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${o2!.id} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/already paid/);
  });

  it('an earlier payout the node refused outright (unknown to it) does not block paying', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: txidFromRawHex(OLD_HEX), signedHex: OLD_HEX })})`;
    const seen: string[] = [];
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async () => -1,
      burn: { verify: async () => { seen.push('burn'); return { ok: false, defer: true, reason: 'stop here' }; } },
    }).processQueued();
    expect(seen).toEqual(['burn']);                       // got past the paid check to the burn check
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  it('node unreachable while checking an earlier payout: defers, signs nothing', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: rnd(32) })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async () => { throw new Error('ECONNREFUSED'); },
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  // ── Review round 7 #2: a malleated copy of an earlier payout ─────────────
  it('an earlier payout unknown by txid but with a spent input (malleated copy) blocks a second payment', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const spentCoin = rnd(32);
    const v = Buffer.alloc(4);
    const oldHex = Buffer.concat([Buffer.from('01000000', 'hex'), Buffer.from([1]), Buffer.from(spentCoin, 'hex').reverse(), v,
      Buffer.from([0]), Buffer.alloc(4, 0xff), Buffer.from([0]), Buffer.alloc(4)]).toString('hex');
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: txidFromRawHex(oldHex), signedHex: oldHex })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async (t) => (t === spentCoin ? 30 : -1),       // the original txid never confirmed (its input's parent did)...
      isUnspent: async (t) => t !== spentCoin,                           // ...but its input was spent
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`
      SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/malleated/);
  });

  // ── Review rounds 8 #2 / 9 #1-#2: who spent an earlier payout's input? ──
  /** A legacy tx hex with the given inputs and outputs (enough for the parsers). */
  function txHex(ins: { txid: string; vout: number }[], outs: { valueSat: bigint; script: string }[]): string {
    const parts: Buffer[] = [Buffer.from('01000000', 'hex'), Buffer.from([ins.length])];
    for (const i of ins) { const v = Buffer.alloc(4); v.writeUInt32LE(i.vout, 0);
      parts.push(Buffer.from(i.txid, 'hex').reverse(), v, Buffer.from([0]), Buffer.alloc(4, 0xff)); }
    parts.push(Buffer.from([outs.length]));
    for (const o of outs) { const a = Buffer.alloc(8); a.writeBigUInt64LE(o.valueSat, 0); const sc = Buffer.from(o.script, 'hex');
      parts.push(a, Buffer.from([sc.length]), sc); }
    parts.push(Buffer.alloc(4));
    return Buffer.concat(parts).toString('hex');
  }
  const P2PKH = (b: string) => '76a914' + b.repeat(20) + '88ac';
  /** Order W with a refused payout t1 spending `coin`; returns what a scenario needs. */
  async function refusedEarlier() {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const coin = rnd(32);
    const t1 = txHex([{ txid: coin, vout: 0 }], [{ valueSat: 200_000n, script: P2PKH('aa') }, { valueSat: 9_000_000n, script: P2PKH('bb') }]);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: txidFromRawHex(t1), signedHex: t1 })})`;
    return { orderId, coin, t1 };
  }
  const verbose = (hex: string, confirmations: number) => ({
    txid: txidFromRawHex(hex), confirmations,
    vin: txInputsFromRawHex(hex).map((i) => ({ txid: i.txid, vout: i.vout })),
    vout: [] as unknown[],
  });
  function nodeWith(txs: Map<string, { hex: string; confs: number; outs: { valueSat: bigint; script: string }[] }>) {
    return async (id: string) => {
      const x = txs.get(id);
      if (!x) throw new RpcCallError('getrawtransaction', -5, 'No such mempool or blockchain transaction');
      return { ...verbose(x.hex, x.confs), vout: x.outs.map((o, n) => ({ value: Number(o.valueSat) / 1e8, n, scriptPubKey: { hex: o.script, type: 'pubkeyhash' } })) };
    };
  }
  async function run(orderId: string, node: (id: string) => Promise<unknown>, coin: string, confs: (t: string) => number) {
    const seen: string[] = [];
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async (t) => (t === coin ? 30 : confs(t)), isUnspent: async (t) => t !== coin, getRawTransactionVerbose: node,
      burn: { verify: async () => { seen.push('burn'); return { ok: false, defer: true, reason: 'stop here' }; } },
    }).processQueued();
    return seen;
  }

  it('legit retry: the input was reused by ANOTHER payout we signed, 6+ deep per our node: proceeds', async () => {
    const { orderId, coin } = await refusedEarlier();
    const { orderId: other } = await order(OutboundState.COMPLETED, 300_000n);
    const outs = [{ valueSat: 300_000n, script: P2PKH('cc') }, { valueSat: 8_900_000n, script: P2PKH('dd') }];
    const u = txHex([{ txid: coin, vout: 0 }], outs);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${other}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: txidFromRawHex(u), signedHex: u })})`;
    const node = nodeWith(new Map([[txidFromRawHex(u), { hex: u, confs: 7, outs }]]));
    expect(await run(orderId, node, coin, (t) => (t === txidFromRawHex(u) ? 7 : -1))).toEqual(['burn']);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  it('the reusing tx is only 2 deep: waits (a miner could still swap the old payout in)', async () => {
    const { orderId, coin } = await refusedEarlier();
    const { orderId: other } = await order(OutboundState.COMPLETED, 300_000n);
    const outs = [{ valueSat: 300_000n, script: P2PKH('cc') }];
    const u = txHex([{ txid: coin, vout: 0 }], outs);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${other}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'test', ${sql.json({ txid: txidFromRawHex(u), signedHex: u })})`;
    const node = nodeWith(new Map([[txidFromRawHex(u), { hex: u, confs: 2, outs }]]));
    expect(await run(orderId, node, coin, (t) => (t === txidFromRawHex(u) ? 2 : -1))).toEqual([]);
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  it('a FORGED audit row naming a confirmed tx that does not spend the input is ignored: parked', async () => {
    const { orderId, coin } = await refusedEarlier();
    const unrelated = rnd(32);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'REFUND_SIGNED', 'queued', 'signed', 'refund-executor', ${sql.json({ txid: unrelated, inputs: [`${coin}:0`] })})`;
    const otherTx = txHex([{ txid: rnd(32), vout: 1 }], [{ valueSat: 5n, script: P2PKH('ee') }]);
    const node = async (id: string) => {
      if (id !== unrelated) throw new RpcCallError('getrawtransaction', -5, 'nope');
      return { ...verbose(otherTx, 50), txid: unrelated, vout: [] };    // confirmed, but spends something else
    };
    expect(await run(orderId, node, coin, (t) => (t === unrelated ? 50 : -1))).toEqual([]);
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
  });

  it('a spender with the SAME outputs as the earlier payout is a malleated copy: parked', async () => {
    const { orderId, coin, t1 } = await refusedEarlier();
    const copy = t1.replace('ffffffff', 'feffffff');                       // different txid, same outputs
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'REFUND_SIGNED', 'queued', 'signed', 'refund-executor', ${sql.json({ txid: txidFromRawHex(copy), inputs: [`${coin}:0`] })})`;
    const outs = [{ valueSat: 200_000n, script: P2PKH('aa') }, { valueSat: 9_000_000n, script: P2PKH('bb') }];
    const node = nodeWith(new Map([[txidFromRawHex(copy), { hex: copy, confs: 40, outs }]]));
    expect(await run(orderId, node, coin, (t) => (t === txidFromRawHex(copy) ? 40 : -1))).toEqual([]);
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`
      SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/malleated/);
  });


  // ── Review round 10 #1 / #2 ──────────────────────────────────────────────
  it('an order the trail never created for this withdrawal is not paid (withdrawal row moved onto it)', async () => {
    const { orderId: o, wid } = await order(OutboundState.COMPLETED, 200_000n);
    const [n1] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat)
      VALUES ('outbound', 'PAYOUT_QUEUED', ${'0x' + '2'.repeat(40)}, ${ADDR}, 200000) RETURNING id`;
    await sql`UPDATE withdrawal_requests SET order_id = ${n1!.id} WHERE order_id = ${o}`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(n1!.id)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${n1!.id} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/no ORDER_CREATED/);
    expect(wid).toBeTruthy();
  });

  it('a payout stamped with the withdrawalId on an order with no ORDER_CREATED is still found', async () => {
    const { orderId, wid } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const [stray] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat)
      VALUES ('outbound', 'COMPLETED', ${'0x' + '2'.repeat(40)}, ${ADDR}, 200000) RETURNING id`;
    const hex = '01000000' + '01' + rnd(32) + '00000000' + '00' + 'ffffffff' + '00' + '00000000';
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${stray!.id}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ withdrawalId: wid, txid: txidFromRawHex(hex), signedHex: hex })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async (t) => (t === txidFromRawHex(hex) ? 9 : -1),
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
  });

  it('a forged row whose txid does not match its signed data parks the order', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const hex = '01000000' + '01' + rnd(32) + '00000000' + '00' + 'ffffffff' + '00' + '00000000';
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ txid: rnd(32), signedHex: hex })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/forged/);
  });

  it('an earlier payout known only by txid (no signed data on record) parks the order', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_BROADCAST', 'PAYOUT_SIGNED', 'PAYOUT_BROADCAST', 'payout-executor', ${sql.json({ txid: rnd(32) })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
  });

  // ── Review round 11: a re-sign must conflict with every earlier attempt still alive ──
  it('a retry spends a coin of the refused earlier attempt, even when a bigger coin is free', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    const smallHex = prevTxPayingDepositKey0(300_000_000n), bigHex = prevTxPayingDepositKey0(9_000_000_000n);
    const small = txidFromRawHex(smallHex), bigCoin = txidFromRawHex(bigHex);
    await sql`UPDATE bridge_utxos SET status = 'spent' WHERE status = 'available'`;
    for (const [c, amt] of [[small, 300_000_000n], [bigCoin, 9_000_000_000n]] as const) {
      await sql`INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, status)
                VALUES (${orderId}, ${c}, 0, ${amt.toString()}, ${ADDR}, 0, 'available')`;
    }
    const earlier = minimalSpend(small, 0);                   // refused before, still a valid signed tx
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ txid: txidFromRawHex(earlier), signedHex: earlier })})`;
    const recipient = new DobbscoinTxBuilder(ROOT.privateExtendedKey, 0).deriveChangeAddress(98);
    await sql`UPDATE bridge_orders SET user_dobbscoin_address = ${recipient} WHERE id = ${orderId}`;
    await sql`UPDATE withdrawal_requests SET dobbscoin_address = ${recipient} WHERE order_id = ${orderId}`;
    await executor(async () => 'x', {
      getRawTransactionHex: async (t) => (t === small ? smallHex : t === bigCoin ? bigHex : (() => { throw new Error('unknown prev'); })()),
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_SIGNED);
    expect(await utxoStatus(small)).toMatchObject({ status: 'reserved' });   // the earlier attempt's coin is spent again
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  it('a retry waits when the refused attempt\'s coins are all held by another signed tx', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    // isolate from orders earlier tests left queued (they would take the big coin)
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE state = 'PAYOUT_QUEUED' AND id <> ${orderId}`;
    const heldHex = prevTxPayingDepositKey0(300_000_007n);   // a distinct amount: same amount = same fake txid
    const held = txidFromRawHex(heldHex);
    await sql`INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, status)
              VALUES (${orderId}, ${held}, 0, 300000007, ${ADDR}, 0, 'reserved')`;
    const earlier = minimalSpend(held, 0);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ txid: txidFromRawHex(earlier), signedHex: earlier })})`;
    const big = await utxo(orderId, 9_000_000_000n);
    await executor(async () => { throw new Error('must not broadcast'); }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);           // deferred, nothing signed
    expect(await utxoStatus(big)).toEqual({ status: 'available', spent_payout_id: null });
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });

  // ── Review round 11 (split): pairwise conflict, missing parent, dead attempt's free coin ──
  it('two earlier attempts both still valid that share no coin: parked (both could confirm)', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE state = 'PAYOUT_QUEUED' AND id <> ${orderId}`;
    const e1 = minimalSpend(rnd(32), 0), e2 = minimalSpend(rnd(32), 1);
    for (const h of [e1, e2]) {
      await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
                VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ txid: txidFromRawHex(h), signedHex: h })})`;
    }
    await executor(async () => { throw new Error('must not broadcast'); }, {
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.MANUAL_REVIEW);
    const [a] = await sql<{ error: string }[]>`SELECT metadata->>'error' AS error FROM audit_events WHERE order_id = ${orderId} AND to_state = 'MANUAL_REVIEW'`;
    expect(a!.error).toMatch(/share no coin/);
  });

  it('an earlier attempt whose input has an unknown parent waits, not "possibly paid"', async () => {
    const { orderId } = await order(OutboundState.PAYOUT_QUEUED, 200_000n);
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE state = 'PAYOUT_QUEUED' AND id <> ${orderId}`;
    const ghost = rnd(32);
    const e = minimalSpend(ghost, 1);
    await sql`INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${orderId}, 'PAYOUT_SIGNED', 'PAYOUT_QUEUED', 'PAYOUT_SIGNED', 'payout-executor', ${sql.json({ txid: txidFromRawHex(e), signedHex: e })})`;
    await executor(async () => { throw new Error('must not broadcast'); }, {
      getConfirmations: async () => -1, isUnspent: async (t) => t !== ghost,
      burn: { verify: async () => { throw new Error('must not be reached'); } },
    }).processQueued();
    expect(await state(orderId)).toBe(OutboundState.PAYOUT_QUEUED);   // waits; the stuck-payout alert covers it
    await sql`UPDATE bridge_orders SET state = 'FAILED' WHERE id = ${orderId}`;
  });
});
