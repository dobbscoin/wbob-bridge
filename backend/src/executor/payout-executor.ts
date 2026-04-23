/**
 * Payout executor — Phase 5.
 *
 * Drives the outbound FSM from PAYOUT_QUEUED through to COMPLETED:
 *
 *   PAYOUT_QUEUED
 *     → select UTXOs, build & sign Dobbscoin tx
 *     → store signed tx in payouts table
 *   PAYOUT_QUEUED → PAYOUT_SIGNED
 *     → sendrawtransaction to Dobbscoin node
 *   PAYOUT_SIGNED → PAYOUT_BROADCAST
 *     → poll confirmations
 *   PAYOUT_BROADCAST → PAYOUT_CONFIRMED → COMPLETED
 */

import type { Sql } from 'postgres';
import { OutboundState, assertOutboundTransition } from '@wbob/shared';
import type { DobbscoinBackendRpc } from '../dobbscoin/rpc.js';
import { DobbscoinTxBuilder, type UtxoInput } from '../dobbscoin/tx-builder.js';
import type { BackendConfig } from '../config.js';

const PAYOUT_MIN_CONFIRMATIONS = 3;

// ─── DB row types ─────────────────────────────────────────────────────────────

interface QueuedPayoutRow {
  order_id:          string;
  dobbscoin_address: string;
  amount_sat:        bigint;
}

interface SignedPayoutRow {
  order_id:   string;
  payout_id:  string;
  signed_hex: string;
}

interface BroadcastPayoutRow {
  order_id:  string;
  payout_id: string;
  txid:      string;
}

interface BridgeUtxoRow {
  id:        string;
  txid:      string;
  vout:      number;
  amount_sat: bigint;
  address:   string;
  hd_index:  number;
}

// ─── PayoutExecutor ───────────────────────────────────────────────────────────

export class PayoutExecutor {
  private readonly txBuilder: DobbscoinTxBuilder;
  private changeIndex = 0;

  constructor(
    private readonly sql: Sql,
    private readonly rpc: DobbscoinBackendRpc,
    private readonly config: BackendConfig,
  ) {
    this.txBuilder = new DobbscoinTxBuilder(
      config.hdWalletXpriv,
      config.dobbscoinAddressVersion,
    );
  }

  async poll(): Promise<void> {
    await this.processQueued();
    await this.broadcastSigned();
    await this.confirmBroadcast();
  }

  async start(): Promise<void> {
    console.log('[payout-executor] started');
    while (true) {
      try { await this.poll(); }
      catch (err) { console.error('[payout-executor] poll error:', err); }
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  // ── Job 1: PAYOUT_QUEUED → PAYOUT_SIGNED ─────────────────────────────────

  private async processQueued(): Promise<void> {
    const queued = await this.sql<QueuedPayoutRow[]>`
      SELECT
        bo.id            AS order_id,
        bo.user_dobbscoin_address AS dobbscoin_address,
        bo.amount_sat
      FROM bridge_orders bo
      LEFT JOIN payouts p ON p.withdrawal_request_id = (
        SELECT id FROM withdrawal_requests wr WHERE wr.order_id = bo.id
      )
      WHERE bo.order_type = 'outbound'
        AND bo.state = ${OutboundState.PAYOUT_QUEUED}
        AND p.id IS NULL
    `;

    for (const row of queued) {
      try {
        await this._buildAndSignPayout(row);
      } catch (err) {
        console.error(`[payout-executor] processQueued error orderId=${row.order_id}:`, err);
        await this._transitionOutbound(
          row.order_id, OutboundState.PAYOUT_QUEUED, OutboundState.MANUAL_REVIEW,
          { error: String(err) },
        );
      }
    }
  }

  private async _buildAndSignPayout(row: QueuedPayoutRow): Promise<void> {
    // Fetch available UTXOs
    const utxoRows = await this.sql<BridgeUtxoRow[]>`
      SELECT id, txid, vout, amount_sat, address, hd_index
      FROM bridge_utxos
      WHERE status = 'available'
      ORDER BY amount_sat DESC
    `;

    if (utxoRows.length === 0) {
      throw new Error('No available bridge UTXOs for payout');
    }

    const utxos: UtxoInput[] = utxoRows.map((u) => ({
      txid:      u.txid,
      vout:      u.vout,
      amountSat: u.amount_sat,
      hdIndex:   u.hd_index,
    }));

    const changeAddress = this.txBuilder.deriveChangeAddress(this.changeIndex);

    const result = await this.txBuilder.buildPayoutTx(
      utxos,
      row.amount_sat,
      row.dobbscoin_address,
      changeAddress,
      this.config.dobbscoinFeeRateSatPerVbyte,
      this.rpc,
    );

    // Atomically: reserve UTXOs, create payout row, advance FSM
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_QUEUED) return;

      // Get withdrawal_request id
      const wrRows = await tx<{ id: string }[]>`
        SELECT id FROM withdrawal_requests WHERE order_id = ${row.order_id}
      `;
      if (wrRows.length === 0) throw new Error('No withdrawal_request row');
      const wrId = wrRows[0]!.id;

      // Create payout row with signed tx
      const payoutRows = await tx<{ id: string }[]>`
        INSERT INTO payouts (withdrawal_request_id, dobbscoin_address, amount_sat, fee_sat)
        VALUES (${wrId}, ${row.dobbscoin_address}, ${row.amount_sat}, ${result.feeSat})
        RETURNING id
      `;
      const payoutId = payoutRows[0]!.id;

      // Store signed_hex in metadata (reuse payout row via separate update — no raw_hex column yet)
      // We store it in audit_events metadata temporarily until broadcast
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${row.order_id},
          'PAYOUT_SIGNED',
          ${OutboundState.PAYOUT_QUEUED},
          ${OutboundState.PAYOUT_SIGNED},
          'payout-executor',
          ${tx.json({
            payoutId,
            signedHex: result.rawHex,
            feeSat: result.feeSat.toString(),
            changeSat: result.changeSat.toString(),
          })}
        )
      `;

      // Reserve UTXOs used in this tx
      const usedTxids = result.inputs.map((u) => u.txid);
      const usedVouts = result.inputs.map((u) => u.vout);
      for (let i = 0; i < usedTxids.length; i++) {
        await tx`
          UPDATE bridge_utxos
          SET status = 'reserved', spent_payout_id = ${payoutId}, updated_at = now()
          WHERE txid = ${usedTxids[i]!} AND vout = ${usedVouts[i]!}
        `;
      }

      await tx`
        UPDATE bridge_orders SET state = ${OutboundState.PAYOUT_SIGNED}, updated_at = now()
        WHERE id = ${row.order_id}
      `;
    });

    this.changeIndex++;
    console.log(`[payout-executor] signed payout orderId=${row.order_id} fee=${result.feeSat}`);
  }

  // ── Job 2: PAYOUT_SIGNED → PAYOUT_BROADCAST ──────────────────────────────

  private async broadcastSigned(): Promise<void> {
    // Retrieve signed hex from the last audit_events entry
    const signed = await this.sql<SignedPayoutRow[]>`
      SELECT
        bo.id AS order_id,
        p.id  AS payout_id,
        (ae.metadata->>'signedHex') AS signed_hex
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      JOIN payouts p ON p.withdrawal_request_id = wr.id
      JOIN audit_events ae ON ae.order_id = bo.id AND ae.event_type = 'PAYOUT_SIGNED'
      WHERE bo.state = ${OutboundState.PAYOUT_SIGNED}
        AND p.txid IS NULL
      ORDER BY ae.id DESC
    `;

    for (const row of signed) {
      if (!row.signed_hex) continue;
      try {
        const txid = await this.rpc.sendRawTransaction(row.signed_hex);

        await this.sql.begin(async (tx) => {
          const rows = await tx<{ state: string }[]>`
            SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_SIGNED) return;

          await tx`
            UPDATE payouts SET txid = ${txid}, broadcast_at = now(), updated_at = now()
            WHERE id = ${row.payout_id}
          `;
          await tx`
            UPDATE bridge_utxos SET status = 'spent', updated_at = now()
            WHERE spent_payout_id = ${row.payout_id}
          `;
          await tx`
            UPDATE bridge_orders SET state = ${OutboundState.PAYOUT_BROADCAST}, updated_at = now()
            WHERE id = ${row.order_id}
          `;
          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${row.order_id}, 'STATE_TRANSITION',
              ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.PAYOUT_BROADCAST},
              'payout-executor', ${tx.json({ txid })}
            )
          `;
        });

        console.log(`[payout-executor] broadcast txid=${txid} orderId=${row.order_id}`);
      } catch (err) {
        console.error(`[payout-executor] broadcastSigned error orderId=${row.order_id}:`, err);
        await this._transitionOutbound(
          row.order_id, OutboundState.PAYOUT_SIGNED, OutboundState.MANUAL_REVIEW,
          { error: String(err) },
        );
      }
    }
  }

  // ── Job 3: PAYOUT_BROADCAST → PAYOUT_CONFIRMED → COMPLETED ───────────────

  private async confirmBroadcast(): Promise<void> {
    const broadcast = await this.sql<BroadcastPayoutRow[]>`
      SELECT bo.id AS order_id, p.id AS payout_id, p.txid
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      JOIN payouts p ON p.withdrawal_request_id = wr.id
      WHERE bo.state = ${OutboundState.PAYOUT_BROADCAST}
        AND p.txid IS NOT NULL
    `;

    for (const row of broadcast) {
      const confs = await this.rpc.getConfirmations(row.txid).catch(() => -1);
      if (confs < PAYOUT_MIN_CONFIRMATIONS) continue;

      await this._transitionOutbound(
        row.order_id, OutboundState.PAYOUT_BROADCAST, OutboundState.PAYOUT_CONFIRMED,
        { txid: row.txid, confirmations: confs },
      );

      await this.sql`
        UPDATE payouts SET confirmed_at = now(), confirmations = ${confs}, updated_at = now()
        WHERE id = ${row.payout_id}
      `;

      await this._transitionOutbound(
        row.order_id, OutboundState.PAYOUT_CONFIRMED, OutboundState.COMPLETED,
        { txid: row.txid },
      );

      console.log(`[payout-executor] payout confirmed txid=${row.txid} orderId=${row.order_id}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async _transitionOutbound(
    orderId: string,
    from: OutboundState,
    to: OutboundState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    assertOutboundTransition(from, to);
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== from) return;
      await tx`
        UPDATE bridge_orders SET state = ${to}, updated_at = now() WHERE id = ${orderId}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId}, 'STATE_TRANSITION', ${from}, ${to},
          'payout-executor', ${tx.json(metadata)}
        )
      `;
    });
  }
}
