/**
 * Gnosis event watcher — Phase 5.
 *
 * Polls BridgeController for WithdrawalRequested events.
 * For each new event:
 *   1. Creates an outbound bridge_order + withdrawal_requests row
 *   2. Drives FSM: WITHDRAW_REQUEST_CREATED → BURN_TX_SEEN
 *   3. Tracks confirmation depth; when reached: BURN_TX_SEEN → BURN_CONFIRMED → PAYOUT_QUEUED
 *
 * Persists the last processed Gnosis block in bridge_state so restarts
 * don't re-process events.
 *
 * Scan policy (see watcher-fix-spec-v2.md):
 *   - Reorg buffer: scan only up to `currentBlock - gnosisConfirmationDepth`
 *     so the watermark never advances past blocks that could still reorg.
 *   - Chunking: walk the range in `gnosisLogScanChunk` windows, bounded by
 *     the upstream RPC's `eth_getLogs` cap (1000 for our self-hosted node).
 *   - Watermark-per-success: advance only past blocks where ALL events
 *     processed; on any `_createWithdrawalOrder` failure, halt advance at
 *     that block, record halt-state for the monitor's observer, return.
 *     `_createWithdrawalOrder` is idempotent (UNIQUE constraint + in-tx
 *     pre-check + full-method transaction), so a re-scan of partially-
 *     succeeded blocks is harmless.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Hex as ViemHex,
} from 'viem';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import { OutboundState, assertOutboundTransition } from '@wbob/shared';
import type { BackendConfig } from '../config.js';
import { sanitizeDobbscoinDestination } from './destination.js';
import { AlertDispatcher } from '../monitor/webhook.js';

// ─── ABI ─────────────────────────────────────────────────────────────────────

const WITHDRAWAL_EVENT = parseAbiItem(
  'event WithdrawalRequested(uint256 indexed withdrawalId, address indexed sender, uint256 amount, string dobbscoinAddress, uint256 nonce)',
);

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ConfirmingBurnRow {
  order_id:         string;
  state:            OutboundState;
  burn_tx_hash:     string;
  burn_block_number: bigint;
}

// ─── GnosisEventWatcher ───────────────────────────────────────────────────────

export class GnosisEventWatcher {
  private readonly publicClient;

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
  ) {
    this.publicClient = createPublicClient({
      chain: gnosis,
      // Pinned to OUR node (review round 7 #3). Through fallback(), the tip
      // could come from one endpoint and the logs from a lagging public one
      // that clamps the range and answers [] : the watermark then moved past
      // real burns and those withdrawals were never paid, with no alert. If
      // the node is down, ingestion waits (payouts need it for the burn check
      // anyway) and the stall alert below fires.
      transport: http(config.gnosisRpcUrl),
    });
    this.alerts = new AlertDispatcher({ webhookUrl: config.alertWebhookUrl, emailTo: config.alertEmailTo });
  }

  private readonly alerts: AlertDispatcher;
  /** Last time processNewWithdrawals completed (null = not yet). */
  private lastScanOk: number | null = null;
  private readonly startedAt = Date.now();
  private stallAlerted = false;
  /** The recount's own cursor: in memory, so a DB writer cannot move it. */
  private recountCursor: bigint | null = null;

  /**
   * Independent recount (review round 7 #3): re-reads every WithdrawalRequested
   * of the controller from GNOSIS_START_BLOCK with its own in-memory cursor and
   * checks each one up to the DB watermark has a withdrawal_requests row. A
   * missing one (skipped by a bad RPC answer, a watermark moved by a DB writer,
   * or a deleted row) is ingested now and alerted. Re-ingesting a burn that was
   * already paid is safe: the payout step refuses it (already-paid check).
   */
  async recount(): Promise<void> {
    const watermark = BigInt(await this._getState('gnosis_last_block'));
    const tip = (await this.publicClient.getBlockNumber()) - BigInt(this.config.gnosisConfirmationDepth);
    const end = watermark < tip ? watermark : tip;
    let from = this.recountCursor ?? this.config.gnosisStartBlock;
    const chunk = BigInt(this.config.gnosisLogScanChunk);
    const missing: string[] = [];
    while (from <= end) {
      const to = from + chunk - 1n < end ? from + chunk - 1n : end;
      const logs = await this.publicClient.getLogs({
        address: this.controllerAddresses(), event: WITHDRAWAL_EVENT, fromBlock: from, toBlock: to,
      });
      if (logs.length > 0) {
        const ids = logs.map((l) => (l.args as { withdrawalId: bigint }).withdrawalId.toString());
        const have = new Set((await this.sql<{ withdrawal_id: string }[]>`
          SELECT withdrawal_id::text FROM withdrawal_requests WHERE withdrawal_id IN ${this.sql(ids)}
        `).map((r) => r.withdrawal_id));
        for (const log of logs) {
          const a = log.args as { withdrawalId: bigint; sender: string; amount: bigint; dobbscoinAddress: string; nonce: bigint };
          if (have.has(a.withdrawalId.toString())) continue;
          missing.push(`${a.withdrawalId} (block ${log.blockNumber}, tx ${log.transactionHash})`);
          await this._createWithdrawalOrder({
            withdrawalId: a.withdrawalId, sender: a.sender, amount: a.amount, dobbscoinAddress: a.dobbscoinAddress,
            nonce: a.nonce, burnTxHash: log.transactionHash ?? '', burnBlockNumber: log.blockNumber ?? 0n,
          });
        }
      }
      this.recountCursor = to + 1n;
      from = to + 1n;
    }
    if (missing.length > 0) {
      await this._alert(`${missing.length} burned withdrawal(s) were missing from the database below the scan ` +
        `watermark and have been ingested now: ${missing.slice(0, 5).join(', ')}. Either an RPC answered wrong or ` +
        `the DB was edited; check how they went missing.`, { missing: missing.slice(0, 20) });
    }
  }

  private async _alert(message: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.alerts.dispatch({ level: 'critical', type: 'GNOSIS_SCAN_HALTED', timestamp: new Date().toISOString(), message, data });
    } catch (err) {
      console.error('[gnosis-watcher] alert failed:', err);
    }
  }

  /** One critical alert when no scan has completed for 30 min; re-armed by the next success. */
  private async _checkStall(): Promise<void> {
    const since = this.lastScanOk ?? this.startedAt;
    if (Date.now() - since < 30 * 60_000 || this.stallAlerted) return;
    this.stallAlerted = true;
    await this._alert(`Withdrawal ingestion has not completed a scan for ${Math.round((Date.now() - since) / 60_000)} min ` +
      `(our Gnosis node ${this.config.gnosisRpcUrl.replace(/\/\/[^@/]*@/, '//')} down or erroring?). Burns are not being picked up.`, {});
  }

  /** BRIDGE_CONTROLLER_ADDRESS plus LEGACY_BRIDGE_CONTROLLER_ADDRESSES, deduplicated. */
  controllerAddresses(): ViemHex[] {
    const all = [this.config.bridgeControllerAddress, ...(this.config.legacyBridgeControllerAddresses ?? [])];
    const seen = new Set<string>();
    return all.filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }) as ViemHex[];
  }

  // ── Main poll ────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    await this.processNewWithdrawals();
    this.lastScanOk = Date.now();
    this.stallAlerted = false;
    await this.confirmPendingBurns();
  }

  async start(): Promise<void> {
    console.log('[gnosis-watcher] started');
    void this._recountLoop();
    while (true) {
      try { await this.poll(); }
      catch (err) { console.error('[gnosis-watcher] poll error:', err); }
      await this._checkStall();
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  /** Recount every 10 min, on its own loop so a slow full pass never delays ingestion. */
  private async _recountLoop(): Promise<void> {
    while (true) {
      try { await this.recount(); }
      catch (err) { console.error('[gnosis-watcher] recount failed (retrying next round):', err); }
      await new Promise<void>((r) => setTimeout(r, 10 * 60_000));
    }
  }

  // ── Scan for new WithdrawalRequested events ───────────────────────────────

  private async processNewWithdrawals(): Promise<void> {
    const lastBlockStr = await this._getState('gnosis_last_block');
    const fromBlock = BigInt(lastBlockStr) + 1n;

    const currentBlock = await this.publicClient.getBlockNumber();
    const safeTip = currentBlock - BigInt(this.config.gnosisConfirmationDepth);
    // Reorg buffer: nothing finality-stable to scan yet.
    if (fromBlock > safeTip) return;

    const chunk = BigInt(this.config.gnosisLogScanChunk);
    let windowStart = fromBlock;

    while (windowStart <= safeTip) {
      const candidateEnd = windowStart + chunk - 1n;
      const windowEnd = candidateEnd < safeTip ? candidateEnd : safeTip;

      const logs = await this.publicClient.getLogs({
        // The current controller plus any legacy ones still inside the
        // confirmation buffer across a cutover (one watermark: same chain).
        // V2 withdrawalIds include the controller address, so ids never collide.
        address: this.controllerAddresses(),
        event: WITHDRAWAL_EVENT,
        fromBlock: windowStart,
        toBlock: windowEnd,
      });

      // Defensive sort by (blockNumber, logIndex). viem returns logs ascending,
      // but if a provider ever violates that an out-of-order log could let the
      // "halt at first failure" path skip an earlier-block event entirely.
      logs.sort((a, b) => {
        const ab = a.blockNumber ?? 0n;
        const bb = b.blockNumber ?? 0n;
        if (ab !== bb) return ab < bb ? -1 : 1;
        return (a.logIndex ?? 0) - (b.logIndex ?? 0);
      });

      for (const log of logs) {
        const { withdrawalId, sender, amount, dobbscoinAddress, nonce } = log.args as {
          withdrawalId: bigint;
          sender:       string;
          amount:       bigint;
          dobbscoinAddress: string;
          nonce:        bigint;
        };

        try {
          await this._createWithdrawalOrder({
            withdrawalId,
            sender,
            amount,
            dobbscoinAddress,
            nonce,
            burnTxHash:      log.transactionHash ?? '',
            burnBlockNumber: log.blockNumber ?? 0n,
            controller:      (log.address ?? this.config.bridgeControllerAddress) as string,
          });
        } catch (err) {
          // Safety wins over speed (spec v2 §"poison-pill semantics").
          // Halt watermark advance at the block BEFORE the failed event.
          // Succeeded events in this block are idempotent no-ops on retry.
          const failedBlock = log.blockNumber ?? windowStart;
          const haltAt = failedBlock - 1n;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            `[gnosis-watcher] withdrawal failed, halting at block ${failedBlock} ` +
            `(withdrawalId=${withdrawalId}): ${errMsg}`,
          );
          await this._recordScanHalt(failedBlock, withdrawalId.toString(), errMsg);
          // Only move the watermark forward — never backward. If the failed
          // event is in fromBlock itself, leave the watermark untouched and
          // let the next poll retry the same fromBlock.
          if (haltAt >= fromBlock) {
            await this._setState('gnosis_last_block', haltAt.toString());
          }
          return;
        }
      }

      // Whole window succeeded → advance watermark past it.
      // If THIS _setState throws (transient Postgres blip), the catch in
      // start() swallows it and the next poll re-scans this window.
      // The re-scan is idempotent (UNIQUE constraint + in-tx pre-check on
      // withdrawal_id), so this degradation is intentional — do not "fix"
      // it into a fragile retry. A transient _setState blip is NOT a
      // poison-pill halt and must not touch the halt-counter state.
      await this._setState('gnosis_last_block', windowEnd.toString());
      windowStart = windowEnd + 1n;
    }

    // Reached safeTip with no halt — any previously-recorded halt is now
    // resolved. Clear halt-state so the monitor stops alerting.
    await this._clearScanHalt();
  }

  private async _createWithdrawalOrder(args: {
    withdrawalId:    bigint;
    sender:          string;
    amount:          bigint;
    dobbscoinAddress: string;
    nonce:           bigint;
    burnTxHash:      string;
    burnBlockNumber: bigint;
    /** Which controller emitted it (V1 or V2 across a cutover). */
    controller?:     string;
  }): Promise<void> {
    const {
      withdrawalId, sender, amount, nonce,
      burnTxHash, burnBlockNumber,
    } = args;
    // The destination string is attacker-chosen; a value Postgres can't store
    // would fail this method forever and halt the scanner for everyone.
    const dest = sanitizeDobbscoinDestination(args.dobbscoinAddress);
    const dobbscoinAddress = dest.value;

    const inserted = await this.sql.begin(async (tx) => {
      // Idempotency: skip if already recorded
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM withdrawal_requests WHERE withdrawal_id = ${withdrawalId.toString()}
      `;
      if (existing.length > 0) return null;

      // Create bridge_order
      const orderRows = await tx<{ id: string }[]>`
        INSERT INTO bridge_orders (
          order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat
        ) VALUES (
          'outbound',
          ${OutboundState.BURN_TX_SEEN},
          ${sender},
          ${dobbscoinAddress},
          ${amount}
        )
        RETURNING id
      `;
      const orderId = orderRows[0]!.id;

      // Create withdrawal_request
      await tx`
        INSERT INTO withdrawal_requests (
          order_id, withdrawal_id, sender_address, dobbscoin_address,
          amount_sat, user_nonce, burn_tx_hash, burn_block_number
        ) VALUES (
          ${orderId},
          ${withdrawalId.toString()},
          ${sender},
          ${dobbscoinAddress},
          ${amount},
          ${nonce},
          ${burnTxHash},
          ${burnBlockNumber}
        )
      `;

      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId},
          'ORDER_CREATED',
          ${OutboundState.WITHDRAW_REQUEST_CREATED},
          ${OutboundState.BURN_TX_SEEN},
          'gnosis-watcher',
          ${tx.json({
            withdrawalId: withdrawalId.toString(),
            burnTxHash,
            burnBlockNumber: burnBlockNumber.toString(),
            controller: args.controller ?? null,
            ...(dest.invalid ? { invalidDestination: true, invalidReason: dest.reason } : {}),
          })}
        )
      `;
      return orderId;
    });

    if (inserted === null) return;
    console.log(`[gnosis-watcher] recorded withdrawal withdrawalId=${withdrawalId}`);

    if (dest.invalid) {
      // No alert from here on purpose: anything awaited in the scan loop can
      // stall ingestion. The payout step parks this order in MANUAL_REVIEW and
      // the solvency monitor alerts (MANUAL_REVIEW_ORDERS) until it is resolved.
      console.error(
        `[gnosis-watcher] INVALID withdrawal destination withdrawalId=${withdrawalId} order=${inserted} ` +
        `sender=${sender} amountSat=${amount} burnTx=${burnTxHash} (${dest.reason}); stored as ${dest.value}`,
      );
    }
  }

  // ── Confirm burns that have reached depth ────────────────────────────────

  private async confirmPendingBurns(): Promise<void> {
    const pendingBurns = await this.sql<ConfirmingBurnRow[]>`
      SELECT
        bo.id             AS order_id,
        bo.state,
        wr.burn_tx_hash,
        wr.burn_block_number
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      WHERE bo.state = ${OutboundState.BURN_TX_SEEN}
        AND wr.burn_block_number IS NOT NULL
    `;

    if (pendingBurns.length === 0) return;

    const currentBlock = await this.publicClient.getBlockNumber();

    for (const row of pendingBurns) {
      const depth = currentBlock - row.burn_block_number;
      if (depth < BigInt(this.config.gnosisConfirmationDepth)) continue;

      try {
        // BURN_TX_SEEN → BURN_CONFIRMED → PAYOUT_QUEUED
        await this._transitionOutbound(
          row.order_id, OutboundState.BURN_TX_SEEN, OutboundState.BURN_CONFIRMED,
          { depth: depth.toString() },
        );
        await this._transitionOutbound(
          row.order_id, OutboundState.BURN_CONFIRMED, OutboundState.PAYOUT_QUEUED,
          {},
        );

        console.log(`[gnosis-watcher] burn confirmed orderId=${row.order_id}`);
      } catch (err) {
        console.error(`[gnosis-watcher] confirmBurn error orderId=${row.order_id}:`, err);
      }
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
        UPDATE bridge_orders SET state = ${to}, updated_at = now()
        WHERE id = ${orderId}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId}, 'STATE_TRANSITION', ${from}, ${to},
          'gnosis-watcher', ${tx.json(metadata)}
        )
      `;
    });
  }

  private async _getState(key: string): Promise<string> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT value FROM bridge_state WHERE key = ${key}
    `;
    return rows[0]?.value ?? '0';
  }

  private async _setState(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO bridge_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()
    `;
  }

  // ── Scan-halt state (observed by SolvencyMonitor) ────────────────────────
  //
  // The watcher writes facts; the monitor decides whether to alert. These
  // helpers ONLY touch the halt-counter state on a real _createWithdrawalOrder
  // failure — transient _setState or getLogs blips never touch them.

  /**
   * Record (or extend) a halt at `block`. If the previous halt was at the
   * same block, increment the counter; if at a different block (or no prior
   * halt), reset to 1. All four keys are written in one transaction so the
   * monitor never reads partial state.
   */
  private async _recordScanHalt(
    block: bigint,
    withdrawalId: string,
    lastError: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ key: string; value: string }[]>`
        SELECT key, value FROM bridge_state
        WHERE key IN ('gnosis_scan_halt_block', 'gnosis_scan_halt_count')
      `;
      const state: Record<string, string> = {};
      for (const r of rows) state[r.key] = r.value;
      const prevBlock = state['gnosis_scan_halt_block'];
      const prevCountRaw = state['gnosis_scan_halt_count'] ?? '0';
      const prevCount = parseInt(prevCountRaw, 10);

      const blockStr = block.toString();
      const sameBlock = prevBlock === blockStr && !isNaN(prevCount);
      const newCount = sameBlock ? prevCount + 1 : 1;
      // Cap the persisted error message to keep bridge_state small. The
      // monitor's alert payload reuses this verbatim, never contains
      // secrets (it's whatever the watcher chose to record).
      const truncatedError = lastError.length > 1000
        ? lastError.slice(0, 1000) + '...[truncated]'
        : lastError;

      const upsert = async (key: string, value: string) => tx`
        INSERT INTO bridge_state (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()
      `;
      await upsert('gnosis_scan_halt_block', blockStr);
      await upsert('gnosis_scan_halt_count', newCount.toString());
      await upsert('gnosis_scan_halt_withdrawal_id', withdrawalId);
      await upsert('gnosis_scan_halt_last_error', truncatedError);
    });
  }

  /**
   * Clear all halt-state keys. Called once per CLEAN sweep that reaches
   * safeTip without halting. A no-halt poll on a non-halted bridge is a
   * cheap no-op (DELETE matches zero rows).
   */
  private async _clearScanHalt(): Promise<void> {
    await this.sql`
      DELETE FROM bridge_state
      WHERE key IN (
        'gnosis_scan_halt_block',
        'gnosis_scan_halt_count',
        'gnosis_scan_halt_withdrawal_id',
        'gnosis_scan_halt_last_error'
      )
    `;
  }
}
