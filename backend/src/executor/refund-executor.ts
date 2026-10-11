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
  type UtxoInput,
} from '../dobbscoin/tx-builder.js';
import { detectDepositSender } from '../dobbscoin/sender.js';
import type { BackendConfig } from '../config.js';
import { AlertDispatcher } from '../monitor/webhook.js';
import type { Alert } from '../monitor/types.js';
import { fmtBob } from './mint-capacity.js';

export const REFUND_MIN_CONFIRMATIONS = 3;
const EXPLORER = 'https://explorer.dobbscoin.info';

export type RefundStatus =
  | 'queued' | 'signed' | 'broadcast' | 'confirmed' | 'needs_attention' | 'too_small';

type RefundRpc = Pick<
  DobbscoinBackendRpc,
  'getRawTransactionVerbose' | 'getRawTransactionHex' | 'sendRawTransaction' | 'getConfirmations'
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
      COALESCE((SELECT MAX(change_index) FROM deposit_refunds), -1)
    ) + 1 AS next
  `;
  return Number(rows[0]?.next ?? 0);
}

export interface RefundExecutorOptions {
  dispatcher?: Pick<AlertDispatcher, 'dispatch'>;
  txBuilder?: Pick<DobbscoinTxBuilder, 'buildRefundTx' | 'deriveChangeAddress'>;
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
  }

  async poll(): Promise<void> {
    const jobs: Array<[string, () => Promise<void>]> = [
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
    const utxoRows = await this.sql<{
      txid: string; vout: number; amount_sat: bigint; hd_index: number; derivation_path: 'deposit' | 'change';
    }[]>`
      SELECT txid, vout, amount_sat, hd_index, derivation_path
      FROM bridge_utxos
      WHERE status = 'available'
    `;
    const utxos: UtxoInput[] = utxoRows.map((u) => ({
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
