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
import { RpcCallError, type DobbscoinBackendRpc } from '../dobbscoin/rpc.js';
import { DobbscoinTxBuilder, DUST_THRESHOLD_SAT, type UtxoInput } from '../dobbscoin/tx-builder.js';
import type { BackendConfig } from '../config.js';
import { nextChangeIndex, type RefundExecutor } from './refund-executor.js';
import { unpayableDestinationReason } from '../gnosis/destination.js';

/** A selected UTXO was reserved by someone else before we could reserve it. */
export class UtxoRaceError extends Error {
  constructor(outpoint: string) { super(`UTXO ${outpoint} was taken before it could be reserved`); this.name = 'UtxoRaceError'; }
}

/** Reason to park a withdrawal too small to pay, before any UTXO is touched; null if payable. */
export function belowPayoutMinimumReason(amountSat: bigint, minSat: bigint): string | null {
  if (amountSat > minSat) return null;
  return `withdrawal of ${amountSat} sat is at or under the payout minimum (${minSat} sat; ` +
    `dust is ${DUST_THRESHOLD_SAT}); not signed. Re-mint the burned wBOB to the sender, or pay by hand.`;
}

/**
 * True only when the node refused the tx for a reason that proves it is in NO
 * mempool and its inputs are not spent by anything else, so they are safe to
 * reuse. ALLOWLIST (fails safe): any reason not listed, including RBF
 * replacement refusals ("insufficient fee, rejecting replacement", "too many
 * potential replacements", ...), mempool conflicts, missing/spent inputs and
 * "already known", keeps the reservation. Codes: -26 RPC_VERIFY_REJECTED,
 * -22 deserialization (the hex never parsed, so nothing was relayed).
 */
const SAFE_REJECTION = new RegExp([
  '\\bdust\\b', 'min relay fee not met', 'insufficient priority', 'mempool min fee not met',
  'rate limited free transaction', 'non-mandatory-script-verify-flag', 'mandatory-script-verify-flag-failed',
  'scriptsig-size', 'scriptsig-not-pushonly', 'scriptpubkey', 'bare-multisig', 'multi-op-return',
  '\\bversion\\b', 'tx-size', 'absurdly-high-fee', 'bad-txns-vout-negative', 'bad-txns-vout-toolarge',
  'bad-txns-oversize', 'bad-txns-txouttotal-toolarge', 'non-final',
].join('|'), 'i');
const UNSAFE_HINT = /replace|conflict|missing|spent|already|known|exists/i;

export function isDefiniteRejection(err: unknown): boolean {
  if (!(err instanceof RpcCallError) || err.method !== 'sendrawtransaction') return false;
  if (err.code === -22) return true;
  if (err.code !== -26) return false;
  return SAFE_REJECTION.test(err.message) && !UNSAFE_HINT.test(err.message);
}


const PAYOUT_MIN_CONFIRMATIONS = 3;

// ─── DB row types ─────────────────────────────────────────────────────────────

interface QueuedPayoutRow {
  order_id:          string;
  dobbscoin_address: string;
  amount_sat:        bigint;
}

interface SignedPayoutRow {
  order_id:       string;
  payout_id:      string;
  signed_hex:     string;
  change_sat:     string | null;   // comes back as JSON string via metadata->>
  change_address: string | null;
  change_index:   string | null;
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
  derivation_path: 'deposit' | 'change';
}

// ─── PayoutExecutor ───────────────────────────────────────────────────────────

export class PayoutExecutor {
  private readonly txBuilder: DobbscoinTxBuilder;
  constructor(
    private readonly sql: Sql,
    private readonly rpc: DobbscoinBackendRpc,
    private readonly config: BackendConfig,
    /**
     * Over-cap deposit refunds. Run inside this executor's poll, after payouts,
     * so payouts and refunds never pick bridge UTXOs at the same time.
     */
    private readonly refunds: RefundExecutor | null = null,
  ) {
    this.txBuilder = new DobbscoinTxBuilder(
      config.hdWalletXpriv,
      config.dobbscoinAddressVersion,
    );
  }

  async poll(): Promise<void> {
    try {
      await this.processQueued();
      await this.broadcastSigned();
      await this.confirmBroadcast();
    } finally {
      // Refunds run even when a payout step throws; same loop, never concurrent.
      if (this.refunds) await this.refunds.poll();
    }
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
      const unpayable = unpayableDestinationReason(row.dobbscoin_address)
        ?? belowPayoutMinimumReason(row.amount_sat, this.config.payoutMinSat);
      if (unpayable !== null) {
        console.error(`[payout-executor] orderId=${row.order_id}: ${unpayable}`);
        try {
          await this._transitionOutbound(
            row.order_id, OutboundState.PAYOUT_QUEUED, OutboundState.MANUAL_REVIEW, { error: unpayable },
          );
        } catch (err) {
          console.error(`[payout-executor] park error orderId=${row.order_id}:`, err);
        }
        continue;
      }
      try {
        await this._buildAndSignPayout(row);
      } catch (err) {
        if (err instanceof UtxoRaceError) {
          console.warn(`[payout-executor] ${err.message}; retrying orderId=${row.order_id} next poll`);
          continue;
        }
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
      SELECT id, txid, vout, amount_sat, address, hd_index, derivation_path
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
      isChange:  u.derivation_path === 'change',
    }));

    // Allocate the next change index from DB (not an in-memory counter — that
    // resets on restart and would reuse the same change address, and also
    // desyncs across multiple backend instances).
    // Also skips indexes held by signed-not-yet-broadcast refunds.
    const changeIndex = await nextChangeIndex(this.sql);
    const changeAddress = this.txBuilder.deriveChangeAddress(changeIndex);

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
            changeAddress: result.changeSat > 0n ? changeAddress : null,
            changeIndex:   result.changeSat > 0n ? changeIndex   : null,
          })}
        )
      `;

      // Reserve UTXOs used in this tx
      const usedTxids = result.inputs.map((u) => u.txid);
      const usedVouts = result.inputs.map((u) => u.vout);
      for (let i = 0; i < usedTxids.length; i++) {
        const got = await tx`
          UPDATE bridge_utxos
          SET status = 'reserved', spent_payout_id = ${payoutId}, updated_at = now()
          WHERE txid = ${usedTxids[i]!} AND vout = ${usedVouts[i]!} AND status = 'available'
          RETURNING id
        `;
        // Someone reserved/spent it since selection: roll back and retry next poll.
        if (got.length !== 1) throw new UtxoRaceError(`${usedTxids[i]}:${usedVouts[i]}`);
      }

      await tx`
        UPDATE bridge_orders SET state = ${OutboundState.PAYOUT_SIGNED}, updated_at = now()
        WHERE id = ${row.order_id}
      `;
    });

    console.log(`[payout-executor] signed payout orderId=${row.order_id} fee=${result.feeSat}`);
  }

  // ── Job 2: PAYOUT_SIGNED → PAYOUT_BROADCAST ──────────────────────────────

  private async broadcastSigned(): Promise<void> {
    // Retrieve signed hex + change-output details from the PAYOUT_SIGNED audit row
    const signed = await this.sql<SignedPayoutRow[]>`
      SELECT
        bo.id AS order_id,
        p.id  AS payout_id,
        (ae.metadata->>'signedHex')     AS signed_hex,
        (ae.metadata->>'changeSat')     AS change_sat,
        (ae.metadata->>'changeAddress') AS change_address,
        (ae.metadata->>'changeIndex')   AS change_index
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      JOIN payouts p ON p.withdrawal_request_id = wr.id
      -- Only the signed hex recorded for THIS payout row. An order re-signed
      -- after a release has older PAYOUT_SIGNED rows whose inputs may be free
      -- again; broadcasting one of those would pay the recipient twice.
      JOIN audit_events ae ON ae.order_id = bo.id AND ae.event_type = 'PAYOUT_SIGNED'
                          AND ae.metadata->>'payoutId' = p.id::text
      WHERE bo.state = ${OutboundState.PAYOUT_SIGNED}
        AND p.txid IS NULL
      ORDER BY ae.id DESC
    `;

    for (const row of signed) {
      if (!row.signed_hex) continue;
      // Record the attempt BEFORE sending. If an earlier attempt exists, that
      // send may have reached peers even though we never recorded success (crash
      // between send and commit), so a later rejection must not free the inputs.
      let priorAttempts: number;
      try {
        priorAttempts = await this._recordBroadcastAttempt(row.order_id, row.payout_id);
      } catch (err) {
        console.error(`[payout-executor] could not record broadcast attempt orderId=${row.order_id}; not sending:`, err);
        continue;
      }
      try {
        const txid = await this.rpc.sendRawTransaction(row.signed_hex);

        await this.sql.begin(async (tx) => {
          const rows = await tx<{ state: string }[]>`
            SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_SIGNED) {
            // The node ACCEPTED this tx, but the order moved meanwhile (another
            // poller parked it, or a hand edit). The coins are spent either way:
            // record that, never leave them 'available'.
            await tx`UPDATE payouts SET txid = ${txid}, broadcast_at = now(), updated_at = now() WHERE id = ${row.payout_id}`;
            await tx`UPDATE bridge_utxos SET status = 'spent', updated_at = now() WHERE spent_payout_id = ${row.payout_id}`;
            await tx`
              INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (${row.order_id}, 'PAYOUT_SENT_OUT_OF_STATE', ${rows[0]?.state ?? null}, ${rows[0]?.state ?? 'UNKNOWN'},
                      'payout-executor', ${tx.json({ txid, payoutId: row.payout_id })})
            `;
            console.error(`[payout-executor] CRITICAL: payout txid=${txid} was accepted but order ${row.order_id} is ` +
              `${rows[0]?.state ?? 'missing'}; recorded the txid and marked inputs spent. Reconcile by hand.`);
            return;
          }

          await tx`
            UPDATE payouts SET txid = ${txid}, broadcast_at = now(), updated_at = now()
            WHERE id = ${row.payout_id}
          `;
          await tx`
            UPDATE bridge_utxos SET status = 'spent', updated_at = now()
            WHERE spent_payout_id = ${row.payout_id}
          `;

          // Ingest the change output as a new spendable UTXO. Convention: the
          // tx-builder always places change at vout=1 (recipient is vout=0),
          // and emits no change output when changeSat <= dust threshold.
          if (row.change_sat && BigInt(row.change_sat) > 0n
              && row.change_address && row.change_index !== null) {
            await tx`
              INSERT INTO bridge_utxos
                (order_id, txid, vout, amount_sat, address, hd_index, derivation_path, status)
              VALUES
                (${row.order_id}, ${txid}, 1, ${BigInt(row.change_sat)},
                 ${row.change_address}, ${parseInt(row.change_index, 10)},
                 'change', 'available')
            `;
          }

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
        if (isDefiniteRejection(err) && priorAttempts === 0) {
          // The node refused the tx outright (dust, fee, non-standard, ...): it is
          // in no mempool, so its inputs are still ours. Free them, or every such
          // payout permanently locks the largest coins (selection is largest-first).
          await this._parkAndRelease(row.order_id, row.payout_id, String(err));
        } else {
          // Timeout, "already in mempool", missing inputs, ...: the tx may be out
          // there. Keep the inputs reserved; releasing them could double-spend.
          await this._transitionOutbound(
            row.order_id, OutboundState.PAYOUT_SIGNED, OutboundState.MANUAL_REVIEW,
            {
              error: String(err),
              inputsHeld: isDefiniteRejection(err)
                ? `node refused it, but ${priorAttempts} earlier broadcast attempt(s) exist: verify the tx is not on the network before releasing its reserved UTXOs`
                : 'the tx may be on the network: reserved UTXOs kept',
            },
          );
        }
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

  /** Append a PAYOUT_BROADCAST_ATTEMPT audit row; returns how many existed before it. */
  private async _recordBroadcastAttempt(orderId: string, payoutId: string): Promise<number> {
    return this.sql.begin(async (tx) => {
      // Serialize concurrent pollers on this order, so two cannot both count 0.
      await tx`SELECT id FROM bridge_orders WHERE id = ${orderId} FOR UPDATE`;
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_events
        WHERE order_id = ${orderId} AND event_type = 'PAYOUT_BROADCAST_ATTEMPT'
          AND metadata->>'payoutId' = ${payoutId}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.PAYOUT_SIGNED},
                'payout-executor', ${tx.json({ payoutId, attempt: c!.n + 1 })})
      `;
      return c!.n;
    });
  }

  /** PAYOUT_SIGNED → MANUAL_REVIEW and return this payout's reserved inputs to the pool, atomically. */
  private async _parkAndRelease(orderId: string, payoutId: string, error: string): Promise<void> {
    assertOutboundTransition(OutboundState.PAYOUT_SIGNED, OutboundState.MANUAL_REVIEW);
    try {
      await this.sql.begin(async (tx) => {
        const rows = await tx<{ state: string }[]>`
          SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
        `;
        if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_SIGNED) return;
        const released = await tx<{ txid: string; vout: number }[]>`
          UPDATE bridge_utxos SET status = 'available', spent_payout_id = NULL, updated_at = now()
          WHERE spent_payout_id = ${payoutId} AND status = 'reserved'
          RETURNING txid, vout
        `;
        await tx`
          UPDATE bridge_orders SET state = ${OutboundState.MANUAL_REVIEW}, updated_at = now() WHERE id = ${orderId}
        `;
        await tx`
          INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
          VALUES (
            ${orderId}, 'STATE_TRANSITION', ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.MANUAL_REVIEW},
            'payout-executor',
            ${tx.json({ error, rejectedByNode: true, utxosReleased: released.map((u) => `${u.txid}:${u.vout}`) })}
          )
        `;
        console.error(`[payout-executor] node rejected payout orderId=${orderId}; released ${released.length} reserved UTXO(s)`);
      });
    } catch (err) {
      console.error(`[payout-executor] park+release error orderId=${orderId}:`, err);
    }
  }

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
