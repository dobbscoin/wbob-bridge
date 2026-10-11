/**
 * Daily mint cap — split, reservation, regeneration, submission and refund,
 * against a real Postgres with every migration (incl. 012) applied.
 *
 * Needs a THROWAWAY database:
 *   REFUND_TEST_DATABASE_URL=postgres://.../wbob_refund_test npx vitest run test/executor
 * Skipped when the variable is unset. It never falls back to DATABASE_URL: the
 * suite TRUNCATEs bridge tables. It uses its own variable (not
 * DATABASE_URL_TEST) because vitest runs files in parallel and the
 * event-watcher suite truncates the same tables.
 *
 * Gnosis and the Dobbscoin node are faked; the Dobbscoin transactions are
 * really built and signed by DobbscoinTxBuilder with a BIP32 test-vector key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  InboundState,
  BRIDGE_CONTROLLER_DOMAIN,
  MINT_AUTHORIZATION_TYPES,
} from '@wbob/shared';
import type { BackendConfig } from '../../src/config.js';
import { MintExecutor, BRIDGE_ABI } from '../../src/executor/mint-executor.js';
import { RefundExecutor } from '../../src/executor/refund-executor.js';
import type { MintCapChainState, MintCapReader } from '../../src/executor/mint-capacity.js';
import { RpcCallError, type RpcVerboseTx } from '../../src/dobbscoin/rpc.js';
import { pubkeyToP2PKH } from '../../src/wallet/hd-wallet.js';
import { ordersRoute } from '../../src/api/routes/orders.js';
import { mintCapRoute } from '../../src/api/routes/mint-cap.js';
import { SolvencyMonitor } from '../../src/monitor/solvency-monitor.js';
import type { Alert } from '../../src/monitor/types.js';

const URL = process.env['REFUND_TEST_DATABASE_URL'];

const BOB = 100_000_000n;
const LIMIT = 1_000_000n * BOB;
const DAY = 86_400n;
const T0 = 1_791_244_800n + 3_600n;             // 2026-10-06T01:00:00Z
const CONTROLLER = '0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872' as Hex;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const ROOT = HDKey.fromMasterSeed(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
const XPRIV = ROOT.privateExtendedKey!;
const SENDER = pubkeyToP2PKH(ROOT.derive('m/9/9').publicKey!, 0x00);
const WATCHER_KEYS = [
  `0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`, `0x${'c3'.repeat(32)}`,
] as Hex[];
const rnd = (n: number) => randomBytes(n).toString('hex');

function makeConfig(over: Partial<BackendConfig> = {}): BackendConfig {
  return {
    gnosisRpcUrl: 'http://192.0.2.1:8545',
    gnosisRpcUrls: ['http://192.0.2.1:8545'],
    executorPrivateKey: `0x${'1'.repeat(64)}`,
    bridgeControllerAddress: CONTROLLER,
    wBobAddress: '0x13550ae65f22A36f60A50d625B70b58666488263',
    mintDeadlineSeconds: 3600,
    executorPollIntervalMs: 15_000,
    dobbscoinChainId: 1_000_001n,
    dobbscoinFeeRateSatPerVbyte: 10,
    dobbscoinAddressVersion: 0,
    hdWalletXpriv: XPRIV,
    refundsAutoSend: true,
    alertWebhookUrl: null,
    alertEmailTo: null,
    stuckOrderThresholdHours: 4,
    chainStallThresholdMinutes: 30,
    lowUtxoThresholdSat: 0,
    alertCooldownMs: 0,
    gnosisScanHaltAlertThreshold: 10,
    ...(over as object),
  } as unknown as BackendConfig;
}

// ─── fakes ───────────────────────────────────────────────────────────────────

class FakeCap implements MintCapReader {
  state: MintCapChainState = {
    dailyMintLimit: LIMIT, currentDayMinted: 0n, currentDayStart: T0 - 3_600n,
    maxSupply: 21_000_000n * BOB, totalSupply: 0n, blockNumber: 1_000n, blockTimestamp: T0,
  };
  mined = new Set<string>();
  delayMs = 0;
  async readState() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return { ...this.state };
  }
  async minedAtOrBefore(h: string) { return this.mined.has(h.toLowerCase()); }
}

class Alerts {
  list: Alert[] = [];
  async dispatch(a: Alert) { this.list.push(a); }
  types() { return this.list.map((a) => a.type); }
}

/** The bits of viem's PublicClient the executor touches. */
class FakeGnosis {
  mintNonce = 0n;
  processed = new Set<string>();
  signers = new Set(WATCHER_KEYS.map((k) => privateKeyToAccount(k).address.toLowerCase()));
  simulateError: Error | null = null;
  simulateCalls = 0;
  async readContract(args: { functionName: string; args?: unknown[] }) {
    switch (args.functionName) {
      case 'mintNonce': return this.mintNonce;
      case 'processedDeposits': return this.processed.has(String(args.args![0]).toLowerCase());
      case 'isSigner': return this.signers.has(String(args.args![0]).toLowerCase());
      default: throw new Error(`unexpected read ${args.functionName}`);
    }
  }
  async simulateContract(req: unknown) {
    this.simulateCalls++;
    if (this.simulateError) throw this.simulateError;
    return { request: req };
  }
  async getTransactionReceipt() { return null; }
}

function p2pkhPrevHex(pubkey: Uint8Array, amountSat: bigint): string {
  const h = ripemd160(sha256(pubkey));
  const script = Buffer.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
  const amt = Buffer.alloc(8); amt.writeBigInt64LE(amountSat, 0);
  const ver = Buffer.alloc(4); ver.writeUInt32LE(1, 0);
  return Buffer.concat([
    ver, Buffer.from([1]), randomBytes(32), Buffer.alloc(4, 0), Buffer.from([0]), Buffer.alloc(4, 0xff),
    Buffer.from([1]), amt, Buffer.from([script.length]), script, Buffer.alloc(4),
  ]).toString('hex');
}
const txidOf = (hex: string) =>
  Buffer.from(sha256(sha256(Buffer.from(hex, 'hex')))).reverse().toString('hex');

/** Dobbscoin node fake: knows deposit txs (raw + verbose) and the sender's funding tx. */
class FakeNode {
  raw = new Map<string, string>();
  verbose = new Map<string, RpcVerboseTx>();
  broadcasts: string[] = [];
  confs = new Map<string, number>();
  broadcastError: Error | null = null;

  addDeposit(depositHex: string, firstInput: RpcVerboseTx['vin'][number]): string {
    const txid = txidOf(depositHex);
    this.raw.set(txid, depositHex);
    this.verbose.set(txid, { txid, vin: [firstInput], vout: [] });
    return txid;
  }
  addFunding(address: string, hash160: string): string {
    const txid = rnd(32);
    this.verbose.set(txid, {
      txid, vin: [{ txid: rnd(32), vout: 0 }],
      vout: [{ value: 1, n: 0, scriptPubKey: { hex: `76a914${hash160}88ac`, type: 'pubkeyhash', addresses: [address] } }],
    });
    return txid;
  }
  async getRawTransactionVerbose(txid: string) {
    const t = this.verbose.get(txid);
    if (!t) throw new RpcCallError('getrawtransaction', -5, 'No such mempool or blockchain transaction');
    return t;
  }
  async getRawTransactionHex(txid: string) {
    const h = this.raw.get(txid);
    if (!h) throw new RpcCallError('getrawtransaction', -5, 'No such mempool or blockchain transaction');
    return h;
  }
  async sendRawTransaction(hex: string) {
    if (this.broadcastError) throw this.broadcastError;
    this.broadcasts.push(hex);
    return txidOf(hex);
  }
  async getConfirmations(txid: string) { return this.confs.get(txid) ?? 0; }
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe.skipIf(!URL)('daily mint cap: split, regenerate, submit, refund (real Postgres)', () => {
  let sql: postgres.Sql<{ bigint: bigint }>;
  let cap: FakeCap;
  let alerts: Alerts;
  let gnosis: FakeGnosis;
  let now: bigint;
  let hdIndex = 0;

  beforeAll(() => {
    sql = postgres(URL!, { types: { bigint: postgres.BigInt }, onnotice: () => {}, max: 6 });
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await sql.unsafe(`ALTER TABLE audit_events DISABLE TRIGGER trg_audit_no_truncate`);
    await sql.unsafe(`ALTER TABLE audit_events DISABLE TRIGGER trg_audit_no_delete`);
    await sql`TRUNCATE bridge_orders, source_deposits, mint_requests, deposit_refunds, bridge_utxos,
                       audit_events, deposit_addresses, payouts, withdrawal_requests, solvency_snapshots
              RESTART IDENTITY CASCADE`;
    await sql.unsafe(`ALTER TABLE audit_events ENABLE TRIGGER trg_audit_no_truncate`);
    await sql.unsafe(`ALTER TABLE audit_events ENABLE TRIGGER trg_audit_no_delete`);
    cap = new FakeCap();
    alerts = new Alerts();
    gnosis = new FakeGnosis();
    now = T0;
    hdIndex = 0;
  });

  function executor(): MintExecutor {
    const me = new MintExecutor(sql as never, makeConfig(), null, {
      capReader: cap, dispatcher: alerts, nowSec: () => now,
    });
    (me as unknown as { publicClient: unknown }).publicClient = gnosis;
    (me as unknown as { walletClient: unknown }).walletClient = {
      writeContract: async () => `0x${rnd(32)}`,
    };
    return me;
  }

  /** An inbound order at DEPOSIT_FINALIZED paying the m/0/<n> deposit address. */
  async function finalizedDeposit(amountSat: bigint, opts: { txid?: string; hdIndex?: number; address?: string } = {}) {
    const idx = opts.hdIndex ?? hdIndex++;
    const address = opts.address ?? pubkeyToP2PKH(ROOT.derive(`m/0/${idx}`).publicKey!, 0);
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
      VALUES ('inbound', ${InboundState.DEPOSIT_FINALIZED}, ${RECIPIENT}, ${amountSat.toString()})
      RETURNING id
    `;
    const txid = opts.txid ?? rnd(32);
    await sql`
      INSERT INTO source_deposits (order_id, deposit_id, deposit_address, hd_index, txid, vout,
                                   amount_sat, confirmations, finalized_at)
      VALUES (${o!.id}, ${randomBytes(32)}, ${address}, ${idx}, ${txid}, 0,
              ${amountSat.toString()}, 60, now())
    `;
    return { orderId: o!.id, txid, address, hdIndex: idx };
  }

  const mintOf = async (orderId: string) =>
    (await sql<{ amount_sat: bigint; deposit_amount_sat: bigint | null }[]>`
      SELECT amount_sat, deposit_amount_sat FROM mint_requests WHERE order_id = ${orderId}`)[0];
  const refundOf = async (orderId: string) =>
    (await sql<{ status: string; excess_sat: bigint; mint_amount_sat: bigint; refund_address: string | null; reason: string | null; txid: string | null; amount_sat: bigint | null; fee_sat: bigint | null; bridge_fee_sat: bigint }[]>`
      SELECT * FROM deposit_refunds WHERE order_id = ${orderId}`)[0];
  const stateOf = async (orderId: string) =>
    (await sql<{ state: string }[]>`SELECT state FROM bridge_orders WHERE id = ${orderId}`)[0]!.state;

  // ── split ────────────────────────────────────────────────────────────────

  it('deposit over what is left today: mints the remainder, queues a refund of the rest', async () => {
    cap.state.currentDayMinted = LIMIT - 100n * BOB;
    const d = await finalizedDeposit(150n * BOB);
    await executor().createPendingAuths();

    expect(await stateOf(d.orderId)).toBe(InboundState.MINT_AUTH_CREATED);
    expect(await mintOf(d.orderId)).toEqual({ amount_sat: 100n * BOB, deposit_amount_sat: 150n * BOB });
    expect(await refundOf(d.orderId)).toMatchObject({ status: 'queued', excess_sat: 50n * BOB, mint_amount_sat: 100n * BOB });
    // the WHOLE deposit enters the pool; the refund takes the excess back out
    const [u] = await sql<{ amount_sat: bigint }[]>`SELECT amount_sat FROM bridge_utxos WHERE order_id = ${d.orderId}`;
    expect(u!.amount_sat).toBe(150n * BOB);
    const [ev] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_events WHERE order_id = ${d.orderId} AND to_state = 'MINT_AUTH_CREATED'`;
    expect(ev!.metadata).toMatchObject({ capSplit: true, mintSat: String(100n * BOB), excessSat: String(50n * BOB) });
  });

  it('under the cap: unchanged behaviour, no refund row', async () => {
    const d = await finalizedDeposit(808n * BOB);
    await executor().createPendingAuths();
    expect(await mintOf(d.orderId)).toEqual({ amount_sat: 808n * BOB, deposit_amount_sat: 808n * BOB });
    expect(await refundOf(d.orderId)).toBeUndefined();
  });

  it('exactly 1,000,000 on a fresh day mints fully', async () => {
    const d = await finalizedDeposit(LIMIT);
    await executor().createPendingAuths();
    expect((await mintOf(d.orderId))!.amount_sat).toBe(LIMIT);
    expect(await refundOf(d.orderId)).toBeUndefined();
  });

  it('1,000,000.00000001 mints 1,000,000 and records the 1 sat as too small to refund', async () => {
    const d = await finalizedDeposit(LIMIT + 1n);
    await executor().createPendingAuths();
    expect((await mintOf(d.orderId))!.amount_sat).toBe(LIMIT);
    expect(await refundOf(d.orderId)).toMatchObject({ status: 'too_small', excess_sat: 1n });
  });

  it('cap already spent: nothing minted, order REFUNDED, whole deposit queued for refund', async () => {
    cap.state.currentDayMinted = LIMIT;
    const d = await finalizedDeposit(42n * BOB);
    await executor().createPendingAuths();
    expect(await stateOf(d.orderId)).toBe(InboundState.REFUNDED);
    expect(await mintOf(d.orderId)).toBeUndefined();
    expect(await refundOf(d.orderId)).toMatchObject({ status: 'queued', excess_sat: 42n * BOB, mint_amount_sat: 0n });
  });

  it('two deposits finalizing in one poll do not both claim the same capacity', async () => {
    cap.state.currentDayMinted = LIMIT - 100n * BOB;
    const a = await finalizedDeposit(60n * BOB);
    const b = await finalizedDeposit(70n * BOB);
    await executor().createPendingAuths();
    const ma = (await mintOf(a.orderId))!.amount_sat;
    const mb = (await mintOf(b.orderId))!.amount_sat;
    expect(ma + mb).toBe(100n * BOB);
    expect(ma).toBe(60n * BOB);
    expect(await refundOf(b.orderId)).toMatchObject({ excess_sat: 30n * BOB });
  });

  it('two executors deciding two different deposits at once stay within capacity (advisory lock)', async () => {
    cap.state.currentDayMinted = LIMIT - 100n * BOB;
    cap.delayMs = 50; // widen the read-decide window: without the lock both would see 100 free
    const a = await finalizedDeposit(60n * BOB);
    const b = await finalizedDeposit(70n * BOB);
    await Promise.all([executor().createPendingAuths([a.orderId]), executor().createPendingAuths([b.orderId])]);
    const total = (await sql<{ total: bigint }[]>`SELECT COALESCE(SUM(amount_sat),0)::bigint AS total FROM mint_requests`)[0]!.total;
    expect(total).toBe(100n * BOB);
    const refunds = await sql`SELECT * FROM deposit_refunds`;
    expect(refunds).toHaveLength(1);
    expect([a.orderId, b.orderId]).toContain(refunds[0]!['order_id']);
  });

  it('stale on-chain window still owes the bridge’s unexecuted reservations', async () => {
    cap.state.currentDayStart = T0 - 3n * DAY;        // window lapsed days ago
    cap.state.currentDayMinted = LIMIT;
    const pending = await finalizedDeposit(300_000n * BOB);
    await executor().createPendingAuths();              // reserves 300k (unsigned)
    const d = await finalizedDeposit(800_000n * BOB);
    await executor().createPendingAuths();
    expect((await mintOf(pending.orderId))!.amount_sat).toBe(300_000n * BOB);
    expect((await mintOf(d.orderId))!.amount_sat).toBe(700_000n * BOB);
    expect(await refundOf(d.orderId)).toMatchObject({ excess_sat: 100_000n * BOB });
  });

  it('a submitted mint already mined at the state block is not double counted', async () => {
    const first = await finalizedDeposit(400_000n * BOB);
    await executor().createPendingAuths();
    const hash = `0x${rnd(32)}`;
    await sql`UPDATE mint_requests SET gnosis_tx_hash = ${hash} WHERE order_id = ${first.orderId}`;
    await sql`UPDATE bridge_orders SET state = 'MINT_SUBMITTED' WHERE id = ${first.orderId}`;
    // the chain already counts it:
    cap.state.currentDayMinted = 400_000n * BOB;
    cap.mined.add(hash);
    const d = await finalizedDeposit(600_000n * BOB);
    await executor().createPendingAuths();
    expect((await mintOf(d.orderId))!.amount_sat).toBe(600_000n * BOB);
    expect(await refundOf(d.orderId)).toBeUndefined();
  });

  // ── regeneration ─────────────────────────────────────────────────────────

  it('expired auth is regenerated: fresh deadline + nonce, signatures cleared, amount kept', async () => {
    cap.state.currentDayMinted = LIMIT - 10n * BOB;
    const d = await finalizedDeposit(25n * BOB);
    const me = executor();
    await me.createPendingAuths();
    await sql`UPDATE mint_requests SET signatures = '[{"signer":"0x1","sig":"0x2"}]'::jsonb, signature_count = 1
              WHERE order_id = ${d.orderId}`;
    now = T0 + 3_600n;              // past the 1-hour deadline
    gnosis.mintNonce = 0n;
    await me.regenerateExpiredAuths();

    const [mr] = await sql<{ deadline: bigint; signature_count: number; amount_sat: bigint; regenerated_count: number; signatures: unknown[] }[]>`
      SELECT deadline, signature_count, amount_sat, regenerated_count, signatures FROM mint_requests WHERE order_id = ${d.orderId}`;
    expect(mr).toMatchObject({ deadline: now + 3_600n, signature_count: 0, amount_sat: 10n * BOB, regenerated_count: 1, signatures: [] });
    const ev = await sql`SELECT * FROM audit_events WHERE order_id = ${d.orderId} AND event_type = 'MINT_AUTH_REGENERATED'`;
    expect(ev).toHaveLength(1);
    expect(alerts.types()).toContain('MINT_AUTH_REGENERATED');
    // only one refund row — regeneration does not re-split a decided amount
    expect(await sql`SELECT * FROM deposit_refunds`).toHaveLength(1);
  });

  it('a changed mintNonce also regenerates', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    gnosis.mintNonce = 7n;
    await me.regenerateExpiredAuths();
    const [mr] = await sql<{ mint_nonce: bigint }[]>`SELECT mint_nonce FROM mint_requests WHERE order_id = ${d.orderId}`;
    expect(mr!.mint_nonce).toBe(7n);
  });

  it('never regenerates a deposit already processed on-chain — alerts instead', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    const [sd] = await sql<{ deposit_id: Buffer }[]>`SELECT deposit_id FROM source_deposits WHERE order_id = ${d.orderId}`;
    gnosis.processed.add(`0x${sd!.deposit_id.toString('hex')}`);
    now = T0 + 7_200n;
    await me.regenerateExpiredAuths();
    await me.regenerateExpiredAuths(); // second pass must not alert again
    const [mr] = await sql<{ regenerated_count: number; last_submit_error: string }[]>`
      SELECT regenerated_count, last_submit_error FROM mint_requests WHERE order_id = ${d.orderId}`;
    expect(mr!.regenerated_count).toBe(0);
    expect(mr!.last_submit_error).toMatch(/^AlreadyProcessed/);
    expect(alerts.list.filter((a) => a.type === 'MINT_SUBMIT_BLOCKED' && a.level === 'critical')).toHaveLength(1);
  });

  it('a pre-012 authorization (no split decided) is split once when it is regenerated', async () => {
    cap.state.currentDayMinted = LIMIT - 30n * BOB;
    const d = await finalizedDeposit(50n * BOB);
    // simulate the old code path: full-amount auth, no deposit_amount_sat
    await sql`
      INSERT INTO mint_requests (order_id, deposit_id, recipient_address, amount_sat, mint_nonce, deadline)
      SELECT ${d.orderId}, deposit_id, ${RECIPIENT}, ${(50n * BOB).toString()}, 0, ${(T0 - 10n).toString()}
      FROM source_deposits WHERE order_id = ${d.orderId}`;
    await sql`UPDATE bridge_orders SET state = 'MINT_AUTH_CREATED' WHERE id = ${d.orderId}`;
    await executor().regenerateExpiredAuths();
    expect(await mintOf(d.orderId)).toEqual({ amount_sat: 30n * BOB, deposit_amount_sat: 50n * BOB });
    expect(await refundOf(d.orderId)).toMatchObject({ excess_sat: 20n * BOB, status: 'queued' });
  });

  // ── submission ───────────────────────────────────────────────────────────

  async function signAll(orderId: string, keys: Hex[], deadlineOverride?: bigint) {
    const [r] = await sql<{ deposit_id: Buffer; amount_sat: bigint; deadline: bigint; mint_nonce: bigint; txid: string }[]>`
      SELECT mr.deposit_id, mr.amount_sat, mr.deadline, mr.mint_nonce, sd.txid
      FROM mint_requests mr JOIN source_deposits sd ON sd.order_id = mr.order_id
      WHERE mr.order_id = ${orderId}`;
    const message = {
      depositId: `0x${r!.deposit_id.toString('hex')}` as Hex,
      recipient: RECIPIENT as Hex,
      amount: r!.amount_sat,
      sourceChainId: 1_000_001n,
      sourceTxHash: `0x${r!.txid}` as Hex,
      sourceVout: 0,
      deadline: deadlineOverride ?? r!.deadline,
      nonce: r!.mint_nonce,
    };
    const sigs = [];
    for (const k of keys) {
      const acct = privateKeyToAccount(k);
      sigs.push({
        signer: acct.address,
        sig: await acct.signTypedData({
          domain: { ...BRIDGE_CONTROLLER_DOMAIN, verifyingContract: CONTROLLER },
          types: MINT_AUTHORIZATION_TYPES, primaryType: 'MintAuthorization', message,
        }),
      });
    }
    await sql`UPDATE mint_requests SET signatures = ${sql.json(sigs)}, signature_count = ${sigs.length}
              WHERE order_id = ${orderId}`;
  }

  it('a signature over a superseded deadline is dropped and nothing is sent', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    await signAll(d.orderId, WATCHER_KEYS.slice(0, 2));
    // third watcher signed the PREVIOUS authorization (old deadline) and appended late
    const signatures = (await sql<{ signatures: object[] }[]>`SELECT signatures FROM mint_requests WHERE order_id = ${d.orderId}`)[0]!.signatures;
    await signAll(d.orderId, [WATCHER_KEYS[2]!], T0 - 1n);
    const stale = (await sql<{ signatures: object[] }[]>`SELECT signatures FROM mint_requests WHERE order_id = ${d.orderId}`)[0]!.signatures;
    await sql`UPDATE mint_requests SET signatures = ${sql.json([...signatures, ...stale] as never)}, signature_count = 3
              WHERE order_id = ${d.orderId}`;
    await me.submitReadyMints();
    expect(gnosis.simulateCalls).toBe(0);
    const [mr] = await sql<{ signature_count: number }[]>`SELECT signature_count FROM mint_requests WHERE order_id = ${d.orderId}`;
    expect(mr!.signature_count).toBe(2);
    expect(await stateOf(d.orderId)).toBe(InboundState.MINT_AUTH_CREATED);
  });

  it('a simulated revert is recorded and alerted once, not sent and not re-alerted', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    await signAll(d.orderId, WATCHER_KEYS);
    gnosis.simulateError = new ContractFunctionRevertedError({
      abi: BRIDGE_ABI,
      functionName: 'executeMint',
      data: encodeErrorResult({ abi: BRIDGE_ABI, errorName: 'ExceedsDailyMintLimit', args: [5n * BOB, 0n] }),
    });
    await me.submitReadyMints();
    await me.submitReadyMints();
    const [mr] = await sql<{ last_submit_error: string; gnosis_tx_hash: string | null }[]>`
      SELECT last_submit_error, gnosis_tx_hash FROM mint_requests WHERE order_id = ${d.orderId}`;
    expect(mr!.last_submit_error).toBe(`ExceedsDailyMintLimit(${5n * BOB}, 0)`);
    expect(mr!.gnosis_tx_hash).toBeNull();
    expect(alerts.list.filter((a) => a.type === 'MINT_SUBMIT_BLOCKED')).toHaveLength(1);
  });

  it('three valid signatures + clean simulation → executeMint sent, MINT_SUBMITTED', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    await signAll(d.orderId, WATCHER_KEYS);
    await me.submitReadyMints();
    expect(gnosis.simulateCalls).toBe(1);
    expect(await stateOf(d.orderId)).toBe(InboundState.MINT_SUBMITTED);
  });

  it('an auth within the deadline margin is not submitted (the regenerator takes it)', async () => {
    const d = await finalizedDeposit(5n * BOB);
    const me = executor();
    await me.createPendingAuths();
    await signAll(d.orderId, WATCHER_KEYS);
    now = T0 + 3_600n - 30n;
    await me.submitReadyMints();
    expect(gnosis.simulateCalls).toBe(0);
  });

  // ── refunds ──────────────────────────────────────────────────────────────

  /** A deposit whose raw tx the fake node knows, funded from SENDER (P2PKH). */
  async function depositFromSender(node: FakeNode, amountSat: bigint, firstInput?: RpcVerboseTx['vin'][number]) {
    const idx = hdIndex++;
    const key = ROOT.derive(`m/0/${idx}`);
    const hex = p2pkhPrevHex(key.publicKey!, amountSat);
    const senderHash = Buffer.from(ripemd160(sha256(ROOT.derive('m/9/9').publicKey!))).toString('hex');
    const funding = node.addFunding(SENDER, senderHash);
    const txid = node.addDeposit(hex, firstInput ?? { txid: funding, vout: 0 });
    const address = pubkeyToP2PKH(key.publicKey!, 0);
    await sql`INSERT INTO deposit_addresses (recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index)
              VALUES (${RECIPIENT}, 'dobbscoin-mainnet', ${address}, ${idx})`;
    return finalizedDeposit(amountSat, { txid, hdIndex: idx, address });
  }

  function refunder(node: FakeNode, over: Partial<BackendConfig> = {}) {
    return new RefundExecutor(sql as never, node as never, makeConfig(over), { dispatcher: alerts });
  }

  it('end to end: sender resolved, announced, signed, broadcast, confirmed — pool keeps exactly the minted part', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT - 40n * BOB;
    const d = await depositFromSender(node, 50n * BOB);
    await executor().createPendingAuths();

    const rx = refunder(node);
    await rx.poll();
    let r = await refundOf(d.orderId);
    expect(r).toMatchObject({ status: 'broadcast', refund_address: SENDER, excess_sat: 10n * BOB, bridge_fee_sat: 0n });
    expect(r!.amount_sat! + r!.fee_sat!).toBe(10n * BOB);           // fee came out of the refund
    expect(node.broadcasts).toHaveLength(1);
    expect(alerts.types()).toEqual(['MINT_CAP_SPLIT', 'REFUND_BROADCAST']);
    expect(alerts.list[0]!.message).toContain(SENDER);
    expect(alerts.list[0]!.message).toContain('Minting 40 wBOB');

    const utxos = await sql<{ txid: string; vout: number; amount_sat: bigint; status: string; derivation_path: string }[]>`
      SELECT txid, vout, amount_sat, status, derivation_path FROM bridge_utxos ORDER BY created_at`;
    expect(utxos).toEqual([
      expect.objectContaining({ txid: d.txid, status: 'spent', amount_sat: 50n * BOB }),
      expect.objectContaining({ txid: r!.txid, vout: 1, status: 'available', amount_sat: 40n * BOB, derivation_path: 'change' }),
    ]);

    node.confs.set(r!.txid!, 3);
    await rx.poll();
    r = await refundOf(d.orderId);
    expect(r!.status).toBe('confirmed');
    expect(alerts.types()).toContain('REFUND_CONFIRMED');

    // solvency: complete the mint and let the monitor do its sums (DB-estimate supply)
    await sql`UPDATE bridge_orders SET state = 'COMPLETED' WHERE id = ${d.orderId}`;
    const mon = new SolvencyMonitor(sql as never, makeConfig({ wBobAddress: null }));
    await mon.poll();
    const snap = mon.getLastSnapshot()!;
    expect(snap.wBobSupplySat).toBe(40n * BOB);      // minted, not deposited
    expect(snap.utxoPoolSat).toBe(40n * BOB);
    expect(snap.cumulativeFeesPaidSat).toBe(0n);     // refund paid its own fee
    expect(snap.isSolvent).toBe(true);
    expect(snap.coverageRatio).toBe(1);
  });

  it('whole-deposit refund (cap spent) leaves nothing in the pool and the order REFUNDED', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT;
    const d = await depositFromSender(node, 7n * BOB);
    await executor().createPendingAuths();
    await refunder(node).poll();
    expect(await stateOf(d.orderId)).toBe(InboundState.REFUNDED);
    const total = (await sql<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount_sat),0)::bigint AS total FROM bridge_utxos WHERE status = 'available'`)[0]!.total;
    expect(total).toBe(0n);
    expect((await refundOf(d.orderId))!.status).toBe('broadcast');
  });

  it('coinbase-funded deposit: refund parked as needs_attention, critical alert, nothing signed', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT - 1n * BOB;
    const d = await depositFromSender(node, 3n * BOB, { coinbase: '03abcdef' });
    await executor().createPendingAuths();
    await refunder(node).poll();
    const r = await refundOf(d.orderId);
    expect(r).toMatchObject({ status: 'needs_attention', refund_address: null, txid: null });
    expect(r!.reason).toMatch(/coinbase/);
    expect(node.broadcasts).toHaveLength(0);
    const crit = alerts.list.filter((a) => a.type === 'REFUND_NEEDS_ATTENTION');
    expect(crit).toHaveLength(1);
    expect(crit[0]!.level).toBe('critical');
    // the mint of what fits still proceeds
    expect((await mintOf(d.orderId))!.amount_sat).toBe(1n * BOB);
  });

  it('REFUNDS_AUTO_SEND=false: resolved and announced, but not signed', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT - 1n * BOB;
    const d = await depositFromSender(node, 3n * BOB);
    await executor().createPendingAuths();
    await refunder(node, { refundsAutoSend: false }).poll();
    expect(await refundOf(d.orderId)).toMatchObject({ status: 'queued', refund_address: SENDER });
    expect(alerts.types()).toEqual(['MINT_CAP_SPLIT']);
    expect(node.broadcasts).toHaveLength(0);
  });

  it('node rejects the refund: needs_attention, inputs stay reserved (never double-spent)', async () => {
    const node = new FakeNode();
    node.broadcastError = new RpcCallError('sendrawtransaction', -26, '16: bad-txns-something');
    cap.state.currentDayMinted = LIMIT - 1n * BOB;
    const d = await depositFromSender(node, 3n * BOB);
    await executor().createPendingAuths();
    await refunder(node).poll();
    expect((await refundOf(d.orderId))!.status).toBe('needs_attention');
    const [u] = await sql<{ status: string }[]>`SELECT status FROM bridge_utxos WHERE txid = ${d.txid}`;
    expect(u!.status).toBe('reserved');
    expect(alerts.types()).toContain('REFUND_NEEDS_ATTENTION');
  });

  it('a transient node outage during sender lookup is retried, not parked', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT - 1n * BOB;
    const d = await depositFromSender(node, 3n * BOB);
    await executor().createPendingAuths();
    const real = node.getRawTransactionVerbose.bind(node);
    node.getRawTransactionVerbose = async () => { throw new Error('ECONNREFUSED'); };
    await refunder(node).poll();
    expect(await refundOf(d.orderId)).toMatchObject({ status: 'queued', refund_address: null });
    node.getRawTransactionVerbose = real;
    await refunder(node).poll();
    expect((await refundOf(d.orderId))!.status).toBe('broadcast');
  });

  // ── API ──────────────────────────────────────────────────────────────────

  it('order API exposes deposited / minted / refund fields; mint-cap API subtracts reservations', async () => {
    const node = new FakeNode();
    cap.state.currentDayMinted = LIMIT - 40n * BOB;
    const d = await depositFromSender(node, 50n * BOB);
    await executor().createPendingAuths();

    const app = Fastify();
    await app.register(ordersRoute, { sql: sql as never });
    await app.register(mintCapRoute, { sql: sql as never, capReader: cap });

    let res = await app.inject({ method: 'GET', url: `/v1/orders/${d.orderId}` });
    expect(res.json()).toMatchObject({
      depositedSat: String(50n * BOB), mintedSat: String(40n * BOB), refundSat: String(10n * BOB),
      refundState: 'queued', refundTxid: null, refundAddress: null,
    });

    await refunder(node).poll();
    res = await app.inject({ method: 'GET', url: `/v1/orders?recipient=${RECIPIENT}` });
    const o = res.json().orders[0];
    expect(o).toMatchObject({ refundState: 'broadcast', refundAddress: SENDER });
    expect(o.refundTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(BigInt(o.refundSentSat) + BigInt(o.refundFeeSat)).toBe(10n * BOB);

    const capRes = (await app.inject({ method: 'GET', url: '/v1/mint-cap' })).json();
    expect(capRes).toMatchObject({
      limitSat: String(LIMIT),
      mintedTodaySat: String(LIMIT - 40n * BOB),
      reservedSat: String(40n * BOB),             // the authorized-not-executed mint
      remainingSat: '0',
      windowStale: false,
      resetsAt: new Date(Number(T0 - 3_600n + DAY) * 1000).toISOString(),
    });
    await app.close();
  });
});
