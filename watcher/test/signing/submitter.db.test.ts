/**
 * Concurrent signature appends, against a real Postgres.
 *
 * Needs a THROWAWAY database with backend/migrations applied:
 *   WATCHER_TEST_DATABASE_URL=postgres://.../wbob_test npx vitest run
 * Skipped when the variable is unset (never falls back to DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { InboundState, type Address, type Hex } from '@wbob/shared';
import { SignatureSubmitter } from '../../src/signing/submitter.js';

const URL = process.env['WATCHER_TEST_DATABASE_URL'];
const rnd = (n: number) => randomBytes(n).toString('hex');

describe.skipIf(!URL)('SignatureSubmitter (real Postgres)', () => {
  const N = 5;
  let conns: postgres.Sql<{ bigint: bigint }>[] = [];

  beforeAll(() => {
    // One pool per "watcher", as in production: each watcher process has its own.
    conns = Array.from({ length: N }, () => postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {} }));
  });
  afterAll(async () => { await Promise.all(conns.map((c) => c.end())); });

  async function mintRequest(): Promise<Hex> {
    const sql = conns[0]!;
    const depositId = randomBytes(32);
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', ${InboundState.MINT_AUTH_CREATED}, '0x000000000000000000000000000000000000dEaD', 1000)
      RETURNING id
    `;
    await sql`
      INSERT INTO source_deposits (order_id, deposit_address, hd_index, source_chain_name, txid, vout, amount_sat, deposit_id)
      VALUES (${o!.id}, ${'regtest-' + rnd(8)}, ${100_000_000 + Math.floor(Math.random() * 1_000_000_000)},
              'dobbscoin-regtest', ${rnd(32)}, 0, 1000, ${depositId})
    `;
    await sql`
      INSERT INTO mint_requests (order_id, deposit_id, recipient_address, amount_sat)
      VALUES (${o!.id}, ${depositId}, '0x000000000000000000000000000000000000dEaD', 1000)
    `;
    return `0x${depositId.toString('hex')}` as Hex;
  }

  it('concurrent appends from different watchers all survive', async () => {
    for (let round = 0; round < 10; round++) {
      const depositId = await mintRequest();
      const signers = conns.map(() => `0x${rnd(20)}` as Address);
      const results = await Promise.all(conns.map((c, i) =>
        new SignatureSubmitter(c).submitSignature(depositId, signers[i]!, `0x${rnd(65)}` as Hex)));
      expect(results.every((r) => r.appended)).toBe(true);
      expect(results.map((r) => r.totalSignatures).sort()).toEqual([1, 2, 3, 4, 5]);
      const stored = await new SignatureSubmitter(conns[0]!).getSignatures(depositId);
      expect(stored.map((e) => e.signer).sort()).toEqual([...signers].sort());
      const counts = await conns[0]!<{ signature_count: number }[]>`
        SELECT signature_count FROM mint_requests WHERE deposit_id = ${Buffer.from(depositId.slice(2), 'hex')}`;
      expect(counts[0]?.signature_count).toBe(N);
    }
  });

  it('the same signer racing itself is appended once', async () => {
    const depositId = await mintRequest();
    const signer = `0x${rnd(20)}` as Address;
    const results = await Promise.all(conns.map((c) =>
      new SignatureSubmitter(c).submitSignature(depositId, signer, `0x${rnd(65)}` as Hex)));
    expect(results.filter((r) => r.appended)).toHaveLength(1);
    expect(await new SignatureSubmitter(conns[0]!).getSignatures(depositId)).toHaveLength(1);
  });
});
