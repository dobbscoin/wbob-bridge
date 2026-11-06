/**
 * V2 refund gate (2026-11 review round 3), against a real Postgres:
 *
 *   REFUND_TEST_DATABASE_URL=postgres://.../wbob_refund_test npx vitest run test/executor/refund-recorder
 *
 * With a recorder (BRIDGE_CONTROLLER_VERSION=2) a refund is never broadcast
 * until V2 shows it recorded; every deposit_refunds row gets recorded. Without
 * one (V1) the broadcast path is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { RefundExecutor } from '../../src/executor/refund-executor.js';
import type { BackendConfig } from '../../src/config.js';

const URL = process.env['REFUND_TEST_DATABASE_URL'];
const rnd = (n: number) => randomBytes(n).toString('hex');

describe.skipIf(!URL)('RefundExecutor V2 recording gate (real Postgres)', () => {
  let sql: postgres.Sql<{ bigint: bigint }>;
  const config = {
    hdWalletXpriv: HDKey.fromMasterSeed(randomBytes(32)).privateExtendedKey,
    dobbscoinAddressVersion: 0,
  } as unknown as BackendConfig;

  beforeAll(() => { sql = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} }); });
  afterAll(async () => { await sql.end(); });

  async function signedRefund() {
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', 'MINT_AUTH_CREATED', ${'0x' + '2'.repeat(40)}, 1000000000) RETURNING id`;
    const txid = rnd(32);
    await sql`
      INSERT INTO deposit_refunds (order_id, deposit_txid, deposit_vout, deposit_amount_sat, mint_amount_sat, excess_sat,
                                   refund_address, status, amount_sat, fee_sat, signed_hex, txid, signed_at)
      VALUES (${o!.id}, ${txid}, 0, 1000000000, 600000000, 400000000, '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN',
              'signed', 399990000, 10000, 'deadbeef', ${rnd(32)}, now())`;
    return { orderId: o!.id, txid };
  }

  const rpc = (sent: string[]) => ({
    sendRawTransaction: async (h: string) => { sent.push(h); return rnd(32); },
    getConfirmations: async () => -1,
  });
  const status = async (orderId: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM deposit_refunds WHERE order_id = ${orderId}`)[0]!.status;

  it('V2: holds the broadcast while the refund is not recorded on-chain, sends it once it is', async () => {
    const { orderId, txid } = await signedRefund();
    let recorded = false;
    const seen: Array<{ depositTxid: string; refundedTotalSat: bigint; depositValueSat: bigint }> = [];
    const recorder = {
      isRecorded: async () => recorded,
      ensureRecorded: async (r: { depositTxid: string; refundedTotalSat: bigint; depositValueSat: bigint }) => { seen.push(r); return recorded; },
    };
    const sent: string[] = [];
    const ex = new RefundExecutor(sql as never, rpc(sent) as never, config, {
      recorder, dispatcher: { dispatch: async () => {} },
    }) as unknown as { broadcastSigned(): Promise<void>; recordRefundsOnChain(): Promise<void> };

    await ex.broadcastSigned();
    expect(sent).toEqual([]);                            // not recorded: nothing goes out
    expect(await status(orderId)).toBe('signed');

    await ex.recordRefundsOnChain();                     // every refund row is offered for recording
    const mine = seen.find((r) => r.depositTxid === txid)!;
    expect(mine.refundedTotalSat).toBe(400000000n);      // excess_sat
    expect(mine.depositValueSat).toBe(1000000000n);      // the whole output

    recorded = true;
    await ex.broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(await status(orderId)).toBe('broadcast');
  });

  it('V1 (no recorder): broadcasts as before', async () => {
    const { orderId } = await signedRefund();
    const sent: string[] = [];
    const ex = new RefundExecutor(sql as never, rpc(sent) as never, config, {
      dispatcher: { dispatch: async () => {} },
    }) as unknown as { broadcastSigned(): Promise<void> };
    await ex.broadcastSigned();
    expect(sent).toContain('deadbeef');
    expect(await status(orderId)).toBe('broadcast');
  });
});
