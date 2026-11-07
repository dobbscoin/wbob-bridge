/**
 * Refund executor — pays the over-cap part of a deposit back to its sender.
 *
 * The mint executor writes a deposit_refunds row when it splits a deposit
 * against the daily mint cap. This drives each row to the end:
 *
 *   queued (no address) ── resolve sender ──► queued (address)   or needs_attention
 *   queued (address)    ── announce split ──► (Discord: "minting A, refunding B to addr")
 *   queued (announced)  ── build + sign   ──► signed             or too_small / needs_attention
 *   signed              ── broadcast      ──► broadcast          or needs_attention
 *   broadcast           ── 3 confs        ──► confirmed
 *
 * A refund is an outbound payout without a burn, and it goes through the same
 * machinery as payouts: DobbscoinTxBuilder for selection, signing and change;
 * bridge_utxos reserved at signing, spent at broadcast; the change output
 * ingested at broadcast as <txid>:1 on the m/1 change path. It runs inside the
 * PayoutExecutor's poll (see payout-executor.ts) so payouts and refunds never
 * select UTXOs concurrently.
 *
 * Accounting: the deposit entered the pool whole; the refund takes exactly
 * excess_sat back out (the fee is deducted from what the sender receives).
 * A change remainder at or under dust is folded into the fee; that sliver is
 * bridge_fee_sat and the solvency monitor counts it with payout fees.
 */

import type { Sql } from 'postgres';
import type { DobbscoinBackendRpc } from '../dobbscoin/rpc.js';
import { RpcCallError, RpcNetworkError } from '../dobbscoin/rpc.js';
import {
  DobbscoinTxBuilder,
  RefundTooSmallError,
  txInputsFromRawHex,
  type UtxoInput,
} from '../dobbscoin/tx-builder.js';
import { detectDepositSender } from '../dobbscoin/sender.js';
import type { BackendConfig } from '../config.js';
import { AlertDispatcher } from '../monitor/webhook.js';
import type { RefundRecorder } from '../gnosis/refund-recorder.js';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import type { Alert } from '../monitor/types.js';
import { fmtBob } from './mint-capacity.js';

export const REFUND_MIN_CONFIRMATIONS = 3;
const EXPLORER = 'https://explorer.dobbscoin.info';

export type RefundStatus =
  | 'queued' | 'signed' | 'broadcast' | 'confirmed' | 'needs_attention' | 'too_small';

type RefundRpc = Pick<
  DobbscoinBackendRpc,
  'getRawTransactionVerbose' | 'getRawTransactionHex' | 'sendRawTransaction' | 'getConfirmations' | 'isUnspent'
>;

interface RefundRow {
  id:                 string;
  order_id:           string;
  deposit_txid:       string;
  deposit_vout:       number;
  deposit_amount_sat: bigint;
  mint_amount_sat:    bigint;
  excess_sat:         bigint;
  refund_address:     string | null;
  status:             RefundStatus;
  reason:             string | null;
  amount_sat:         bigint | null;
  fee_sat:            bigint | null;
  signed_hex:         string | null;
  txid:               string | null;
  change_sat:         bigint | null;
  change_address:     string | null;
  change_index:       number | null;
  user_gnosis_address: string | null;
}

/**
 * Next change index on m/1. Counts change indexes held by refunds that are
 * signed but not yet broadcast (their change is not in bridge_utxos yet), so a
 * payout and a refund never share a change address.
 */
export async function nextChangeIndex(sql: Sql): Promise<number> {
  const rows = await sql<{ next: number }[]>`
    SELECT GREATEST(
      COALESCE((SELECT MAX(hd_index) FROM bridge_utxos WHERE derivation_path = 'change'), -1),
      COALESCE((SELECT MAX(change_index) FROM deposit_refunds), -1),
      -- Payout change indexes live only in PAYOUT_SIGNED audit metadata until
      -- broadcast; include every one ever signed so none is handed out twice.
      COALESCE((SELECT MAX((metadata->>'changeIndex')::int) FROM audit_events
                WHERE event_type = 'PAYOUT_SIGNED' AND metadata->>'changeIndex' IS NOT NULL), -1)
    ) + 1 AS next
  `;
  return Number(rows[0]?.next ?? 0);
}

export interface RefundExecutorOptions {
  dispatcher?: Pick<AlertDispatcher, 'dispatch'>;
  txBuilder?: Pick<DobbscoinTxBuilder, 'buildRefundTx' | 'deriveChangeAddress'>;
  /**
   * BridgeControllerV2 only: records each refund on-chain (recordRefund) so the
   * contract enforces minted + refunded <= value per output. When set, a refund
   * is NEVER broadcast until V2 shows it recorded. Null/absent = V1 behavior.
   */
  recorder?: Pick<RefundRecorder, 'ensureRecorded' | 'isRecorded' | 'mintedAmount' | 'isImported'> | null;
}

export class RefundExecutor {
  private readonly txBuilder: Pick<DobbscoinTxBuilder, 'buildRefundTx' | 'deriveChangeAddress'>;
  private readonly alerts: Pick<AlertDispatcher, 'dispatch'>;

  constructor(
    private readonly sql: Sql,
    private readonly rpc: RefundRpc,
    private readonly config: BackendConfig,
    opts: RefundExecutorOptions = {},
  ) {
    this.txBuilder = opts.txBuilder ?? new DobbscoinTxBuilder(
      config.hdWalletXpriv,
      config.dobbscoinAddressVersion,
    );
    this.alerts = opts.dispatcher ?? new AlertDispatcher({
      webhookUrl: config.alertWebhookUrl,
      emailTo:    config.alertEmailTo,
    });
    this.recorder = opts.recorder ?? null;
  }

  private readonly recorder: Pick<RefundRecorder, 'ensureRecorded' | 'isRecorded' | 'mintedAmount' | 'isImported'> | null;
  private depositScripts: HDKey | null = null;
  /** Refund ids whose on-chain record we already confirmed (or alerted on) this process. */
  private readonly recordedIds = new Set<string>();
  private readonly recordAlerted = new Set<string>();
  /** Refund ids whose node check passed this process (V2 broadcast gate). */
  private readonly backedIds = new Set<string>();

  // ── 0. Record refunds on V2 (BridgeControllerV2 only) ─────────────────────
  //
  // As soon as the bridge has decided part of a deposit will NOT be minted (a
  // deposit_refunds row exists, in any state), V2 must know: otherwise a DB
  // writer could later mint against those coins. Recording can only block.
  async recordRefundsOnChain(): Promise<void> {
    if (!this.recorder) return;
    // EVERY refund row, sent ones too: a refund paid before V2 existed (or by
    // hand, recorded as a row) must still be known to V2, or its coins could be
    // minted on V2 as well. Only outputs V2 imported from V1 are skipped: V2
    // can never mint those, and it refuses refunds against them.
    const rows = await this.sql<(RefundRow & { hd_index: number | null })[]>`
      SELECT r.*, NULL::text AS user_gnosis_address, sd.hd_index
      FROM deposit_refunds r
      LEFT JOIN source_deposits sd ON sd.order_id = r.order_id
      WHERE r.status <> 'too_small'
    `;
    for (const r of rows) {
      if (this.recordedIds.has(r.id)) continue;
      const rec = this._rec(r);
      const sent = r.status === 'broadcast' || r.status === 'confirmed';
      try {
        if (await this.recorder.isImported(rec)) {
          if (sent) { this.recordedIds.add(r.id); continue; }       // settled before the cutover
          // Unsent refund on an imported output: V2 will never let it be recorded.
          if (r.status === 'queued' || r.status === 'signed') {
            await this._park(r, r.status, 'needs_attention',
              'refund refused: output was imported from V1 (settle it by hand: V2 cannot record it)', 'critical');
          }
          continue;
        }
        // Never record (so never send) a refund the chain does not back. The
        // row's numbers come from the DB; check them against our own node,
        // every time, even when V2 already shows a record.
        const why = await this._refundNotBackedReason(r, r.hd_index, { requireUnspent: false });
        if (why !== null) {
          if (why.defer) continue;
          if (r.status === 'queued' || r.status === 'signed') {
            await this._park(r, r.status, 'needs_attention', `refund refused: ${why.reason}`, 'critical');
          } else if (!this.recordAlerted.has(r.id)) {
            this.recordAlerted.add(r.id);
            await this._alert({ level: 'critical', type: 'REFUND_NEEDS_ATTENTION',
              message: `Refund ${r.id} (order ${r.order_id}, status ${r.status}) is not backed on-chain: ${why.reason}`,
              data: { refundId: r.id, orderId: r.order_id, reason: why.reason } });
          }
          continue;
        }
        if (await this.recorder.ensureRecorded(rec)) { this.recordedIds.add(r.id); this.backedIds.add(r.id); }
      } catch (err) {
        console.error(`[refund-executor] recordRefund failed refundId=${r.id}:`, err);
        if (!this.recordAlerted.has(r.id)) {
          this.recordAlerted.add(r.id);
          await this._alert({ level: 'critical', type: 'REFUND_NEEDS_ATTENTION',
            message: `Could not record refund ${r.id} (order ${r.order_id}) on BridgeControllerV2: ${String(err).slice(0, 200)}. ` +
              `The refund will NOT be sent until it is recorded (check REFUND_MARKER_ROLE and relayer gas).`,
            data: { refundId: r.id, orderId: r.order_id } });
        }
      }
    }
  }

  private _rec(r: RefundRow) {
    return { depositTxid: r.deposit_txid, depositVout: r.deposit_vout,
             depositValueSat: r.deposit_amount_sat, refundedTotalSat: r.excess_sat };
  }

  /**
   * Does the chain back this refund? Our node must show the deposit output as
   * the bridge's exact P2PKH script at hd_index (derived from HD_WALLET_XPUB),
   * worth exactly deposit_amount_sat, with at least FINAL_CONFIRMATIONS; with
   * requireUnspent, still unspent (the refund spends it). On V2 also: not
   * imported from V1, and refund + already-minted <= value.
   * Returns null if backed; defer = could not tell (node down, not deep yet).
   */
  private async _refundNotBackedReason(
    r: RefundRow, hdIndex: number | null, opts: { requireUnspent: boolean },
  ): Promise<{ defer: boolean; reason: string } | null> {
    const no = (reason: string) => ({ defer: false, reason });
    if (hdIndex === null) return no('no hd_index for the deposit (cannot derive the bridge address)');
    let t;
    let confs: number;
    try {
      [t, confs] = await Promise.all([
        this.rpc.getRawTransactionVerbose(r.deposit_txid),
        this.rpc.getConfirmations(r.deposit_txid),
      ]);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === -5) return no(`deposit tx ${r.deposit_txid} is not on our node`);
      return { defer: true, reason: `node unreachable: ${String(err).slice(0, 120)}` };
    }
    const out = t.vout.find((v) => v.n === r.deposit_vout);
    if (!out) return no(`deposit tx has no output ${r.deposit_vout}`);
    if (!this.depositScripts) this.depositScripts = HDKey.fromExtendedKey(this.config.hdWalletXpub);
    const pub = this.depositScripts.derive(`${this.config.hdDerivationPath}/${hdIndex}`).publicKey;
    if (!pub) return no(`cannot derive the bridge key at hd_index ${hdIndex}`);
    const expected = `76a914${Buffer.from(ripemd160(sha256(pub))).toString('hex')}88ac`;
    if (out.scriptPubKey.hex.toLowerCase() !== expected) {
      return no(`output ${r.deposit_vout} is not the bridge's P2PKH at hd_index ${hdIndex}`);
    }
    const value = BigInt(Math.round(out.value * 1e8));
    if (value !== r.deposit_amount_sat) return no(`output value ${value} != recorded deposit ${r.deposit_amount_sat}`);
    if (r.excess_sat <= 0n || r.excess_sat > value) return no(`refund ${r.excess_sat} is not within the output's ${value}`);
    if (confs < this.config.depositFinalConfirmations) {
      return { defer: true, reason: `deposit has ${confs} confirmation(s), needs ${this.config.depositFinalConfirmations}` };
    }
    if (opts.requireUnspent) {
      let unspent: boolean;
      try { unspent = await this.rpc.isUnspent(r.deposit_txid, r.deposit_vout); }
      catch (err) { return { defer: true, reason: `gettxout failed: ${String(err).slice(0, 120)}` }; }
      if (!unspent) return no(`deposit output ${r.deposit_txid}:${r.deposit_vout} is already spent (a refund always spends it; check for an earlier refund)`);
    }
    if (this.recorder) {
      const rec = this._rec(r);
      if (await this.recorder.isImported(rec)) return no('output was minted on V1 (imported); no refund can be owed on it');
      const minted = await this.recorder.mintedAmount(rec);
      if (r.excess_sat + minted > value) return no(`refund ${r.excess_sat} + minted ${minted} exceeds the output's ${value}`);
    }
    return null;
  }

  async poll(): Promise<void> {
    const jobs: Array<[string, () => Promise<void>]> = [
      ['recordOnChain',    () => this.recordRefundsOnChain()],
      ['resolveSenders',   () => this.resolveSenders()],
      ['announceSplits',   () => this.announceSplits()],
      ['signQueued',       () => this.signQueued()],
      ['broadcastSigned',  () => this.broadcastSigned()],
      ['confirmBroadcast', () => this.confirmBroadcast()],
    ];
    for (const [name, job] of jobs) {
      try {
        await job();
      } catch (err) {
        console.error(`[refund-executor] ${name} failed:`, err);
      }
    }
  }

  // ── 1. Who sent it ───────────────────────────────────────────────────────

  async resolveSenders(): Promise<void> {
    const rows = await this.sql<{ id: string; order_id: string; deposit_txid: string }[]>`
      SELECT id, order_id, deposit_txid
      FROM deposit_refunds
      WHERE status = 'queued' AND refund_address IS NULL
      ORDER BY created_at
    `;
    if (rows.length === 0) return;

    const bridgeAddrRows = await this.sql<{ address: string }[]>`
      SELECT dobbscoin_address AS address FROM deposit_addresses
      UNION
      SELECT address FROM bridge_utxos
    `;
    const bridgeAddresses = new Set(bridgeAddrRows.map((r) => r.address));

    for (const row of rows) {
      let result;
      try {
        result = await detectDepositSender(
          this.rpc, row.deposit_txid, this.config.dobbscoinAddressVersion, bridgeAddresses,
        );
      } catch (err) {
        // Node unreachable etc. — not a verdict on the sender. Retry next poll.
        console.error(`[refund-executor] sender lookup failed (will retry) refundId=${row.id}:`, err);
        continue;
      }
      if (result.ok) {
        await this.sql`
          UPDATE deposit_refunds
          SET refund_address = ${result.address}, sender_detail = ${this.sql.json({ ...result.detail })}
          WHERE id = ${row.id} AND status = 'queued' AND refund_address IS NULL
        `;
        console.log(`[refund-executor] sender resolved refundId=${row.id} address=${result.address}`);
      } else {
        await this.sql`
          UPDATE deposit_refunds
          SET status = 'needs_attention', reason = ${result.reason},
              sender_detail = ${this.sql.json({ ...result.detail })}
          WHERE id = ${row.id} AND status = 'queued' AND refund_address IS NULL
        `;
        await this._audit(row.order_id, 'REFUND_NEEDS_ATTENTION', 'queued', 'needs_attention', { reason: result.reason });
        console.error(`[refund-executor] NEEDS ATTENTION refundId=${row.id}: ${result.reason}`);
      }
    }
  }

  // ── 2. Tell Discord about the split (once per refund) ────────────────────

  async announceSplits(): Promise<void> {
    const rows = await this.sql<RefundRow[]>`
      SELECT r.*, bo.user_gnosis_address
      FROM deposit_refunds r
      JOIN bridge_orders bo ON bo.id = r.order_id
      WHERE r.split_alerted_at IS NULL
        AND (r.refund_address IS NOT NULL OR r.status IN ('needs_attention', 'too_small'))
      ORDER BY r.created_at
    `;
    for (const r of rows) {
      const head =
        `Deposit of ${fmtBob(r.deposit_amount_sat)} (BOB) is over today's wBOB mint cap ` +
        `(order ${r.order_id}, ${EXPLORER}/tx/${r.deposit_txid}). ` +
        (r.mint_amount_sat > 0n
          ? `Minting ${fmtBob(r.mint_amount_sat)} wBOB to ${r.user_gnosis_address ?? '?'}; `
          : `Nothing left under today's cap, minting none; `);
      let alert: Omit<Alert, 'timestamp'>;
      if (r.status === 'needs_attention') {
        alert = {
          level: 'critical',
          type: 'REFUND_NEEDS_ATTENTION',
          message: head +
            `${fmtBob(r.excess_sat)} (BOB) to refund, but the refund NEEDS ATTENTION: ${r.reason ?? 'unknown'}. ` +
            `Nothing was sent. Set deposit_refunds.refund_address and status='queued' to release it.`,
          data: { orderId: r.order_id, refundId: r.id, excessSat: r.excess_sat.toString(), reason: r.reason },
        };
      } else if (r.status === 'too_small') {
        alert = {
          level: 'info',
          type: 'MINT_CAP_SPLIT',
          message: head +
            `the ${fmtBob(r.excess_sat)} (BOB) over the cap is too small to refund (not more than the network fee + dust) ` +
            `and stays in the bridge pool.`,
          data: { orderId: r.order_id, refundId: r.id, excessSat: r.excess_sat.toString() },
        };
      } else {
        alert = {
          level: 'info',
          type: 'MINT_CAP_SPLIT',
          message: head +
            `refunding ${fmtBob(r.excess_sat)} (BOB) (less the network fee) to ${r.refund_address}.` +
            (this.config.refundsAutoSend ? '' : ' REFUNDS_AUTO_SEND is off: the refund waits for an operator.'),
          data: {
            orderId: r.order_id, refundId: r.id, excessSat: r.excess_sat.toString(),
            mintSat: r.mint_amount_sat.toString(), refundAddress: r.refund_address,
          },
        };
      }
      await this._alert(alert);
      await this.sql`UPDATE deposit_refunds SET split_alerted_at = now() WHERE id = ${r.id}`;
    }
  }

  // ── 3. Build + sign ──────────────────────────────────────────────────────

  async signQueued(): Promise<void> {
    if (!this.config.refundsAutoSend) return;
    const rows = await this.sql<RefundRow[]>`
      SELECT r.*, NULL::text AS user_gnosis_address
      FROM deposit_refunds r
      WHERE r.status = 'queued' AND r.refund_address IS NOT NULL AND r.split_alerted_at IS NOT NULL
      ORDER BY r.created_at
    `;
    for (const r of rows) {
      try {
        await this._signOne(r);
      } catch (err) {
        if (
          err instanceof RpcNetworkError ||
          (err instanceof Error && /^Insufficient UTXOs|is no longer available$/.test(err.message))
        ) {
          // Node unreachable, or coins reserved by an in-flight payout (they come
          // back as change). Transient: retry next poll.
          console.warn(`[refund-executor] refundId=${r.id} not built yet, will retry: ${err.message}`);
          continue;
        }
        if (err instanceof RefundTooSmallError) {
          await this._park(r, 'queued', 'too_small', err.message, null);
          continue;
        }
        await this._park(r, 'queued', 'needs_attention', `could not build the refund: ${String(err)}`, 'critical');
      }
    }
  }

  private async _signOne(r: RefundRow): Promise<void> {
    // 1. The chain must back it (also re-checked at broadcast on V2).
    const [sd] = await this.sql<{ hd_index: number | null }[]>`
      SELECT hd_index FROM source_deposits WHERE order_id = ${r.order_id}`;
    const why = await this._refundNotBackedReason(r, sd?.hd_index ?? null, { requireUnspent: true });
    if (why !== null) {
      if (why.defer) { console.warn(`[refund-executor] refundId=${r.id} not signed yet: ${why.reason}`); return; }
      await this._park(r, 'queued', 'needs_attention', `refund refused: ${why.reason}`, 'critical');
      return;
    }
    // 2. The address comes from the node again, not from the row.
    const bridgeAddrRows = await this.sql<{ address: string }[]>`
      SELECT dobbscoin_address AS address FROM deposit_addresses UNION SELECT address FROM bridge_utxos`;
    const sender = await detectDepositSender(
      this.rpc, r.deposit_txid, this.config.dobbscoinAddressVersion, new Set(bridgeAddrRows.map((x) => x.address)));
    if (!sender.ok || sender.address !== r.refund_address) {
      await this._park(r, 'queued', 'needs_attention',
        `refund refused: refund_address ${r.refund_address} is not the deposit's sender per our node ` +
        `(${sender.ok ? sender.address : sender.reason})`, 'critical');
      return;
    }
    // 3. Spend the deposit output ITSELF (and only it): one output can then fund
    //    at most one refund, by consensus, whatever the DB says.
    const utxoRows = await this.sql<{
      txid: string; vout: number; amount_sat: bigint; hd_index: number; derivation_path: 'deposit' | 'change'; status: string;
    }[]>`
      SELECT txid, vout, amount_sat, hd_index, derivation_path, status
      FROM bridge_utxos
      WHERE txid = ${r.deposit_txid} AND vout = ${r.deposit_vout}
    `;
    const dep = utxoRows[0];
    if (!dep || dep.status !== 'available') {
      if (dep?.status === 'reserved') throw new Error(`deposit output ${r.deposit_txid}:${r.deposit_vout} is no longer available`);
      await this._park(r, 'queued', 'needs_attention',
        `refund refused: the deposit output is ${dep ? dep.status : 'not in bridge_utxos'} (a refund must spend it)`, 'critical');
      return;
    }
    if (dep.amount_sat !== r.deposit_amount_sat) {
      await this._park(r, 'queued', 'needs_attention', 'refund refused: bridge_utxos value of the deposit output disagrees', 'critical');
      return;
    }
    const utxos: UtxoInput[] = [dep].map((u) => ({
      txid: u.txid, vout: u.vout, amountSat: u.amount_sat, hdIndex: u.hd_index,
      isChange: u.derivation_path === 'change',
    }));

    const changeIndex = await nextChangeIndex(this.sql);
    const changeAddress = this.txBuilder.deriveChangeAddress(changeIndex);
    const built = await this.txBuilder.buildRefundTx(
      utxos,
      r.excess_sat,
      r.refund_address!,
      changeAddress,
      this.config.dobbscoinFeeRateSatPerVbyte,
      this.rpc as DobbscoinBackendRpc,
      { txid: r.deposit_txid, vout: r.deposit_vout },
    );

    if (built.inputs.length !== 1 || built.inputs[0]!.txid !== r.deposit_txid || built.inputs[0]!.vout !== r.deposit_vout) {
      throw new Error('refund tx does not spend exactly the deposit output');
    }

    await this.sql.begin(async (tx) => {
      const cur = await tx<{ status: string; refund_address: string | null }[]>`
        SELECT status, refund_address FROM deposit_refunds WHERE id = ${r.id} FOR UPDATE
      `;
      if (cur[0]?.status !== 'queued' || cur[0]?.refund_address !== r.refund_address) return;

      for (const input of built.inputs) {
        const res = await tx`
          UPDATE bridge_utxos
          SET status = 'reserved', spent_refund_id = ${r.id}, updated_at = now()
          WHERE txid = ${input.txid} AND vout = ${input.vout} AND status = 'available'
        `;
        if (res.count !== 1) throw new Error(`UTXO ${input.txid}:${input.vout} is no longer available`);
      }

      const hasChange = built.changeSat > 0n;
      await tx`
        UPDATE deposit_refunds
        SET status         = 'signed',
            amount_sat     = ${built.recipientSat.toString()},
            fee_sat        = ${built.feeSat.toString()},
            bridge_fee_sat = ${built.bridgeFeeSat.toString()},
            signed_hex     = ${built.rawHex},
            txid           = ${built.txid},
            change_sat     = ${built.changeSat.toString()},
            change_address = ${hasChange ? changeAddress : null},
            change_index   = ${hasChange ? changeIndex : null},
            signed_at      = now()
        WHERE id = ${r.id}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${r.order_id}, 'REFUND_SIGNED', 'queued', 'signed', 'refund-executor',
          ${tx.json({
            refundId: r.id,
            txid: built.txid,
            refundAddress: r.refund_address,
            excessSat: r.excess_sat.toString(),
            recipientSat: built.recipientSat.toString(),
            feeSat: built.feeSat.toString(),
            bridgeFeeSat: built.bridgeFeeSat.toString(),
            changeSat: built.changeSat.toString(),
            inputs: built.inputs.map((i) => `${i.txid}:${i.vout}`),
          })}
        )
      `;
    });
    console.log(
      `[refund-executor] signed refund refundId=${r.id} txid=${built.txid} ` +
      `to=${r.refund_address} amount=${built.recipientSat} fee=${built.feeSat}`,
    );
  }

  // ── 4. Broadcast ─────────────────────────────────────────────────────────

  async broadcastSigned(): Promise<void> {
    const rows = await this.sql<RefundRow[]>`
      SELECT r.*, NULL::text AS user_gnosis_address
      FROM deposit_refunds r
      WHERE r.status = 'signed' AND r.signed_hex IS NOT NULL
      ORDER BY r.signed_at
    `;
    for (const r of rows) {
      // Every refund spends its own deposit output; never send a tx that doesn't.
      let ins: { txid: string; vout: number }[];
      try { ins = txInputsFromRawHex(r.signed_hex!); } catch { ins = []; }
      if (!ins.some((i) => i.txid === r.deposit_txid && i.vout === r.deposit_vout)) {
        await this._park(r, 'signed', 'needs_attention',
          `signed refund ${r.txid} does not spend its deposit output; not sent`, 'critical');
        continue;
      }
      // V2: never send coins back before the contract knows (else the same
      // coins could still be minted by a DB writer), and only after this
      // process's node check passed for this row.
      if (this.recorder && !this.backedIds.has(r.id)) {
        console.warn(`[refund-executor] refund ${r.id} not node-checked + recorded in this process yet; holding the broadcast`);
        continue;
      }
      if (this.recorder) {
        const recorded = await this.recorder.isRecorded({
          depositTxid: r.deposit_txid, depositVout: r.deposit_vout,
          depositValueSat: r.deposit_amount_sat, refundedTotalSat: r.excess_sat,
        }).catch(() => false);
        if (!recorded) {
          console.warn(`[refund-executor] refund ${r.id} not recorded on V2 yet; holding the broadcast`);
          continue;
        }
      }
      let txid: string;
      try {
        txid = await this.rpc.sendRawTransaction(r.signed_hex!);
      } catch (err) {
        if (err instanceof RpcCallError) {
          // -27 = already in the chain; "already known"/"already in mempool" = an
          // earlier attempt got through. Either way it is out.
          if (err.code === -27 || /already/i.test(err.message)) {
            txid = r.txid!;
          } else {
            await this._park(r, 'signed', 'needs_attention',
              `node rejected the signed refund ${r.txid}: ${err.message}. Inputs stay reserved; ` +
              `reset status to 'signed' to retry, or release the inputs by hand`, 'critical');
            continue;
          }
        } else {
          console.error(`[refund-executor] broadcast failed (will retry) refundId=${r.id}:`, err);
          continue;
        }
      }
      if (r.txid && txid !== r.txid) {
        console.warn(`[refund-executor] node txid ${txid} differs from computed ${r.txid} refundId=${r.id}`);
      }

      await this.sql.begin(async (tx) => {
        const cur = await tx<{ status: string }[]>`
          SELECT status FROM deposit_refunds WHERE id = ${r.id} FOR UPDATE
        `;
        if (cur[0]?.status !== 'signed') return;
        await tx`
          UPDATE deposit_refunds
          SET status = 'broadcast', txid = ${txid}, broadcast_at = now()
          WHERE id = ${r.id}
        `;
        await tx`
          UPDATE bridge_utxos SET status = 'spent', updated_at = now()
          WHERE spent_refund_id = ${r.id}
        `;
        // Same convention as payouts: recipient vout 0, change vout 1.
        if (r.change_sat !== null && r.change_sat > 0n && r.change_address && r.change_index !== null) {
          await tx`
            INSERT INTO bridge_utxos
              (order_id, txid, vout, amount_sat, address, hd_index, derivation_path, status)
            VALUES
              (${r.order_id}, ${txid}, 1, ${r.change_sat.toString()}, ${r.change_address}, ${r.change_index},
               'change', 'available')
            ON CONFLICT (txid, vout) DO NOTHING
          `;
        }
        await tx`
          INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
          VALUES (
            ${r.order_id}, 'REFUND_BROADCAST', 'signed', 'broadcast', 'refund-executor',
            ${tx.json({ refundId: r.id, txid })}
          )
        `;
      });

      console.log(`[refund-executor] broadcast refund txid=${txid} refundId=${r.id}`);
      await this._alert({
        level: 'info',
        type: 'REFUND_BROADCAST',
        message:
          `Refund broadcast: ${fmtBob(r.amount_sat ?? 0n)} (BOB) to ${r.refund_address} ` +
          `(order ${r.order_id}, ${fmtBob(r.excess_sat)} over the cap less ${fmtBob(r.fee_sat ?? 0n)} fee). ` +
          `${EXPLORER}/tx/${txid}`,
        data: { orderId: r.order_id, refundId: r.id, txid },
      });
    }
  }

  // ── 5. Confirm ───────────────────────────────────────────────────────────

  async confirmBroadcast(): Promise<void> {
    const rows = await this.sql<RefundRow[]>`
      SELECT r.*, NULL::text AS user_gnosis_address
      FROM deposit_refunds r
      WHERE r.status = 'broadcast' AND r.txid IS NOT NULL
    `;
    for (const r of rows) {
      const confs = await this.rpc.getConfirmations(r.txid!).catch(() => -1);
      if (confs < 0) continue;
      if (confs < REFUND_MIN_CONFIRMATIONS) {
        await this.sql`UPDATE deposit_refunds SET confirmations = ${confs} WHERE id = ${r.id} AND status = 'broadcast'`;
        continue;
      }
      const done = await this.sql`
        UPDATE deposit_refunds
        SET status = 'confirmed', confirmations = ${confs}, confirmed_at = now()
        WHERE id = ${r.id} AND status = 'broadcast'
      `;
      if (done.count === 0) continue;
      await this._audit(r.order_id, 'REFUND_CONFIRMED', 'broadcast', 'confirmed', { refundId: r.id, txid: r.txid, confirmations: confs });
      console.log(`[refund-executor] refund confirmed txid=${r.txid} refundId=${r.id}`);
      await this._alert({
        level: 'info',
        type: 'REFUND_CONFIRMED',
        message:
          `Refund confirmed (${confs} confs): ${fmtBob(r.amount_sat ?? 0n)} (BOB) to ${r.refund_address} ` +
          `(order ${r.order_id}). ${EXPLORER}/tx/${r.txid}`,
        data: { orderId: r.order_id, refundId: r.id, txid: r.txid, confirmations: confs },
      });
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async _park(
    r: RefundRow,
    from: RefundStatus,
    to: 'needs_attention' | 'too_small',
    reason: string,
    level: Alert['level'] | null,
  ): Promise<void> {
    const res = await this.sql`
      UPDATE deposit_refunds SET status = ${to}, reason = ${reason}
      WHERE id = ${r.id} AND status = ${from}
    `;
    if (res.count === 0) return;
    await this._audit(r.order_id, to === 'too_small' ? 'REFUND_TOO_SMALL' : 'REFUND_NEEDS_ATTENTION', from, to, { refundId: r.id, reason });
    console.error(`[refund-executor] refundId=${r.id} ${from} → ${to}: ${reason}`);
    await this._alert({
      level: level ?? 'info',
      type: to === 'needs_attention' ? 'REFUND_NEEDS_ATTENTION' : 'MINT_CAP_SPLIT',
      message:
        to === 'needs_attention'
          ? `Refund of ${fmtBob(r.excess_sat)} (BOB) for order ${r.order_id} NEEDS ATTENTION: ${reason}`
          : `Refund of ${fmtBob(r.excess_sat)} (BOB) for order ${r.order_id} is too small to send: ${reason}`,
      data: { orderId: r.order_id, refundId: r.id, reason },
    });
  }

  private async _audit(
    orderId: string, eventType: string, from: string, to: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (${orderId}, ${eventType}, ${from}, ${to}, 'refund-executor', ${this.sql.json(metadata as never)})
    `;
  }

  private async _alert(a: Omit<Alert, 'timestamp'>): Promise<void> {
    try {
      await this.alerts.dispatch({ ...a, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[refund-executor] alert dispatch failed:', err);
    }
  }
}
