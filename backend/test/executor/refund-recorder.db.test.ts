/**
 * V2 refund gate (review rounds 3 + 4), against a real Postgres:
 *
 *   REFUND_TEST_DATABASE_URL=postgres://.../wbob_refund_test npx vitest run test/executor/refund-recorder
 *
 * With a recorder (BRIDGE_CONTROLLER_VERSION=2): a refund is recorded only after
 * our node confirms the deposit output is the bridge's P2PKH at hd_index with
 * the recorded value (and V2 did not import it from V1); it is never broadcast
 * until V2 shows it recorded. Without one (V1) the broadcast path is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { RefundExecutor } from '../../src/executor/refund-executor.js';
import type { BackendConfig } from '../../src/config.js';

const URL = process.env['REFUND_TEST_DATABASE_URL'];
const rnd = (n: number) => randomBytes(n).toString('hex');
const ROOT = HDKey.fromMasterSeed(randomBytes(32));
const scriptAt = (i: number) =>
  `76a914${Buffer.from(ripemd160(sha256(ROOT.derive(`m/0/${i}`).publicKey!))).toString('hex')}88ac`;

describe.skipIf(!URL)('RefundExecutor V2 recording gate (real Postgres)', () => {
  let sql: postgres.Sql<{ bigint: bigint }>;
  let hd = 500_000 + Math.floor(Math.random() * 100_000);
  const config = {
    hdWalletXpriv: ROOT.privateExtendedKey,
    hdWalletXpub: ROOT.publicExtendedKey,
    hdDerivationPath: 'm/0',
    dobbscoinAddressVersion: 0,
  } as unknown as BackendConfig;

  beforeAll(() => { sql = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });

  /** A deposit of `value` sat at a fresh hd_index, with a refund row of `excess` in `status`. */
  async function refundRow(opts: { value?: bigint; recordedValue?: bigint; excess?: bigint; status?: string } = {}) {
    const value = opts.value ?? 1_000_000_000n;
    const index = hd++;
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', 'MINT_AUTH_CREATED', ${'0x' + '2'.repeat(40)}, ${value}) RETURNING id`;
    const txid = rnd(32);
    await sql`
      INSERT INTO source_deposits (order_id, deposit_address, hd_index, source_chain_name, txid, vout, amount_sat)
      VALUES (${o!.id}, ${'1dep' + index}, ${index}, 'dobbscoin-mainnet', ${txid}, 0, ${value})`;
    const status = opts.status ?? 'signed';
    await sql`
      INSERT INTO deposit_refunds (order_id, deposit_txid, deposit_vout, deposit_amount_sat, mint_amount_sat, excess_sat,
                                   refund_address, status, amount_sat, fee_sat, signed_hex, txid, signed_at)
      VALUES (${o!.id}, ${txid}, 0, ${opts.recordedValue ?? value}, 600000000, ${opts.excess ?? 400000000n},
              '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN', ${status}, 399990000, 10000,
              ${status === 'signed' ? 'deadbeef' : null}, ${rnd(32)}, now())`;
    return { orderId: o!.id, txid, index, value };
  }

  const rpcFor = (nodeOut: Map<string, { value: number; hex: string }>, sent: string[]) => ({
    sendRawTransaction: async (h: string) => { sent.push(h); return rnd(32); },
    getConfirmations: async () => -1,
    getRawTransactionVerbose: async (txid: string) => {
      const o = nodeOut.get(txid);
      if (!o) throw new Error('unknown tx');
      return { txid, vout: [{ n: 0, value: o.value, scriptPubKey: { hex: o.hex, type: 'pubkeyhash' } }], vin: [] };
    },
  });
  const status = async (orderId: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM deposit_refunds WHERE order_id = ${orderId}`)[0]!.status;

  function recorderFake(opts: { imported?: Set<string> } = {}) {
    const recorded = new Map<string, bigint>();
    return {
      recorded,
      isRecorded: async (r: { depositTxid: string; refundedTotalSat: bigint }) => (recorded.get(r.depositTxid) ?? -1n) >= r.refundedTotalSat,
      ensureRecorded: async (r: { depositTxid: string; refundedTotalSat: bigint }) => { recorded.set(r.depositTxid, r.refundedTotalSat); return true; },
      mintedAmount: async () => 0n,
      isImported: async (r: { depositTxid: string }) => opts.imported?.has(r.depositTxid) ?? false,
    };
  }

  function executor(rpc: unknown, recorder: unknown) {
    return new RefundExecutor(sql as never, rpc as never, config, {
      recorder: recorder as never, dispatcher: { dispatch: async () => {} },
    }) as unknown as { broadcastSigned(): Promise<void>; recordRefundsOnChain(): Promise<void> };
  }

  it('V2: holds the broadcast until recorded; records only after the node backs it; then sends', async () => {
    const d = await refundRow();
    const node = new Map([[d.txid, { value: 10, hex: scriptAt(d.index) }]]);
    const sent: string[] = [];
    const rec = recorderFake();
    const ex = executor(rpcFor(node, sent), rec);
    await ex.broadcastSigned();
    expect(sent).toEqual([]);                            // not recorded yet: nothing goes out
    await ex.recordRefundsOnChain();
    expect(rec.recorded.get(d.txid)).toBe(400000000n);   // recorded with excess_sat
    await ex.broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(await status(d.orderId)).toBe('broadcast');
  });

  it('a DB-inflated deposit value is refused: parked, never recorded, never sent', async () => {
    const d = await refundRow({ value: 1_000_000_000n, recordedValue: 5_000_000_000n, excess: 4_400_000_000n });
    const node = new Map([[d.txid, { value: 10, hex: scriptAt(d.index) }]]);   // the node says 10 BOB
    const sent: string[] = [];
    const rec = recorderFake();
    const ex = executor(rpcFor(node, sent), rec);
    await ex.recordRefundsOnChain();
    expect(rec.recorded.has(d.txid)).toBe(false);
    expect(await status(d.orderId)).toBe('needs_attention');
    await ex.broadcastSigned();
    expect(sent).toEqual([]);
  });

  it('an output that is not the bridge P2PKH at its hd_index is refused', async () => {
    const d = await refundRow();
    const node = new Map([[d.txid, { value: 10, hex: scriptAt(d.index + 1) }]]);  // someone else's script
    const rec = recorderFake();
    await executor(rpcFor(node, []), rec).recordRefundsOnChain();
    expect(rec.recorded.has(d.txid)).toBe(false);
    expect(await status(d.orderId)).toBe('needs_attention');
  });

  it('a V1-imported (already minted) output is refused', async () => {
    const d = await refundRow();
    const node = new Map([[d.txid, { value: 10, hex: scriptAt(d.index) }]]);
    const rec = recorderFake({ imported: new Set([d.txid]) });
    await executor(rpcFor(node, []), rec).recordRefundsOnChain();
    expect(rec.recorded.has(d.txid)).toBe(false);
    expect(await status(d.orderId)).toBe('needs_attention');
  });

  it('refunds already broadcast/confirmed are not re-recorded', async () => {
    const d = await refundRow({ status: 'confirmed' });
    const rec = recorderFake();
    await executor(rpcFor(new Map(), []), rec).recordRefundsOnChain();
    expect(rec.recorded.has(d.txid)).toBe(false);
  });

  it('V1 (no recorder): broadcasts as before', async () => {
    const d = await refundRow();
    const sent: string[] = [];
    await executor(rpcFor(new Map(), sent), null).broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(await status(d.orderId)).toBe('broadcast');
  });
});
