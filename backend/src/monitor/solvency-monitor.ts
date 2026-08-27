/**
 * SolvencyMonitor — Phase 8.
 *
 * Runs on a configurable interval and checks:
 *   1. wBOB totalSupply (on Gnosis chain, or DB estimate if address not configured)
 *   2. Available bridge UTXO pool (DB)
 *   3. Pending payout obligations (DB)
 *   4. Orders stuck in non-terminal state (DB)
 *
 * Persists each check in solvency_snapshots and dispatches alerts when
 * thresholds are breached.  Per-type cooldowns prevent alert spam.
 */

import {
  createPublicClient,
  http,
  fallback,
  parseAbiItem,
  type Address as ViemAddress,
} from 'viem';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import type { BackendConfig } from '../config.js';
import type { Alert,SolvencySnapshot, AlertType } from './types.js';
import { checkSolvency, checkStuckOrders, buildAlerts, checkDripWalletBalance, checkScanHalt } from './checks.js';
import { AlertDispatcher } from './webhook.js';
import type { DripSender } from '../executor/drip-sender.js';
import type { DobbscoinBackendRpc } from '../dobbscoin/rpc.js';

const TOTAL_SUPPLY_ABI = parseAbiItem('function totalSupply() view returns (uint256)');

// Terminal states that do not count as "stuck".
const TERMINAL_STATES = `('COMPLETED', 'FAILED', 'MANUAL_REVIEW')`;

export class SolvencyMonitor {
  private readonly publicClient;
  private readonly dispatcher: AlertDispatcher;
  private lastSnapshot: SolvencySnapshot | null = null;
  /** Last verdict from a poll that actually read the chain. Stale polls do not touch it. */
  private lastKnownSolvent: boolean | null = null;
  /** Epoch-ms of the last dispatch per alert type (for cooldown). */
  private readonly alertCooldowns = new Map<AlertType, number>();

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
    private readonly dripSender: DripSender | null = null,
    private readonly rpc: DobbscoinBackendRpc | null = null,
  ) {
    this.publicClient = createPublicClient({
      chain: gnosis,
      // READ path: fallback() across the ordered RPC list so reads survive the
      // node going down. Writers stay pinned to gnosisRpcUrl — see config.ts.
      transport: fallback(config.gnosisRpcUrls.map((u) => http(u))),
    });
    this.dispatcher = new AlertDispatcher({
      webhookUrl: config.alertWebhookUrl,
      emailTo:    config.alertEmailTo,
    });
  }

  /** Latest snapshot — exposed to the health endpoint. */
  getLastSnapshot(): SolvencySnapshot | null {
    return this.lastSnapshot;
  }

  // ── Main poll ────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    const checkedAt = new Date().toISOString();

    // 1. wBOB supply — chain is the only source that can contradict the DB
    const { supply: wBobSupplySat, source: supplySource } = await this._readWBobSupply();
    const supplyIsStale = supplySource === 'db-estimate' && Boolean(this.config.wBobAddress);

    // 1b. Chain liveness — by far the usual reason orders stop moving.
    const chainTipAgeSec = await this._readChainTipAgeSec();
    const chainIsStalled =
      chainTipAgeSec !== null &&
      chainTipAgeSec > this.config.chainStallThresholdMinutes * 60;

    // 2. Available UTXO pool
    const utxoRows = await this.sql<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount_sat), 0)::bigint AS total
      FROM bridge_utxos
      WHERE status = 'available'
    `;
    const utxoPoolSat = utxoRows[0]!.total;

    // 2b. Cumulative payout fees the bridge has subsidised. Anything past
    // broadcast (txid is set) has actually left the pool. Adding this to the
    // pool side prevents fee drift from looking like a solvency breach.
    const feeRows = await this.sql<{ total: bigint }[]>`
      SELECT COALESCE(SUM(fee_sat), 0)::bigint AS total
      FROM payouts
      WHERE txid IS NOT NULL AND fee_sat IS NOT NULL
    `;
    const cumulativeFeesPaidSat = feeRows[0]!.total;

    // 3. Outstanding withdrawal obligations (non-terminal outbound orders)
    const pendingRows = await this.sql<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount_sat), 0)::bigint AS total
      FROM bridge_orders
      WHERE order_type = 'outbound'
        AND state NOT IN ('COMPLETED', 'FAILED', 'MANUAL_REVIEW')
    `;
    const pendingPayoutsSat = pendingRows[0]!.total;

    // 4. Non-terminal orders — check for stuck
    const stuckThresholdMs = this.config.stuckOrderThresholdHours * 3_600_000;
    const nonTerminal = await this.sql<{
      id: string;
      state: string;
      updated_at: Date;
    }[]>`
      SELECT id, state, updated_at
      FROM bridge_orders
      WHERE state NOT IN ('COMPLETED', 'FAILED', 'MANUAL_REVIEW')
    `;
    const stuckIds = checkStuckOrders(
      nonTerminal.map((r) => ({ id: r.id, state: r.state, updatedAt: r.updated_at })),
      stuckThresholdMs,
    );

    // 5. Build snapshot
    const { isSolvent, coverageRatio } = checkSolvency(
      wBobSupplySat,
      utxoPoolSat,
      cumulativeFeesPaidSat,
    );
    const snapshot: SolvencySnapshot = {
      checkedAt,
      wBobSupplySat,
      utxoPoolSat,
      cumulativeFeesPaidSat,
      pendingPayoutsSat,
      coverageRatio,
      isSolvent,
      stuckOrderCount: stuckIds.length,
      supplySource,
      supplyIsStale,
      chainTipAgeSec,
      chainIsStalled,
    };

    // 6. Persist (cap coverageRatio at 999999 for the NUMERIC column)
    // Cast bigint → string because the postgres driver's TS types don't accept bigint
    // in tagged template literals (though the BigInt type registration handles it at runtime).
    const ratioStored = Math.min(coverageRatio, 999_999);
    // is_solvent is NOT NULL, so there is no honest "unknown" row to write.
    // Skip the insert entirely rather than record a verdict we do not have.
    if (!supplyIsStale) await this.sql`
      INSERT INTO solvency_snapshots (
        checked_at, wbob_supply_sat, utxo_pool_sat, cumulative_fees_paid_sat,
        pending_payouts_sat, coverage_ratio, is_solvent, stuck_order_count
      ) VALUES (
        ${checkedAt},
        ${wBobSupplySat.toString()},
        ${utxoPoolSat.toString()},
        ${cumulativeFeesPaidSat.toString()},
        ${pendingPayoutsSat.toString()},
        ${ratioStored},
        ${isSolvent},
        ${stuckIds.length}
      )
    `;

    // 7. Purge snapshots older than 30 days
    await this.sql`
      DELETE FROM solvency_snapshots
      WHERE checked_at < NOW() - INTERVAL '30 days'
    `;

    // 8. Build and dispatch alerts (with per-type cooldown)
    const previouslySolvent = this.lastKnownSolvent;
    this.lastSnapshot = snapshot;

    const alerts: Alert[] = [];
    if (supplyIsStale) {
      // Deliberately NOT calling buildAlerts: with a stale supply it could emit
      // SOLVENCY_RECOVERED off a number that cannot disagree with itself, which is
      // exactly the false all-clear this guard exists to prevent. lastKnownSolvent
      // is left untouched so the next good poll still sees the true previous state.
      alerts.push({
        level: 'warning',
        type: 'SUPPLY_READ_STALE',
        timestamp: checkedAt,
        message:
          'wBOB totalSupply could not be read from Gnosis. Solvency verdict WITHHELD and no ' +
          'snapshot recorded for this cycle — the DB estimate is derived from the same rows ' +
          'as the pool side and cannot contradict it. Check the Gnosis RPC endpoint.',
        data: {
          supplySource,
          dbEstimateSat: wBobSupplySat.toString(),
          utxoPoolSat: utxoPoolSat.toString(),
          wBobAddress: this.config.wBobAddress ?? null,
        },
      });
    } else {
      this.lastKnownSolvent = isSolvent;
      alerts.push(...buildAlerts(
        snapshot,
        previouslySolvent,
        BigInt(this.config.lowUtxoThresholdSat),
      ));
    }

    // ── Drip wallet balance (Option 2) ──────────────────────────────────────
    if (this.dripSender) {
      try {
        const balance = await this.dripSender.getWalletBalanceWei();
        alerts.push(
          ...checkDripWalletBalance(
            this.dripSender.walletAddress,
            balance,
            this.config.dripAmountWei,
            this.config.dripLowWaterMarkWei,
            checkedAt,
          ),
        );
      } catch (err) {
        console.error('[solvency-monitor] drip wallet balance read failed:', err);
      }
    }

    // ── Gnosis log-scan halt (independent observer of the watcher's state) ──
    // The watcher records halt facts to bridge_state when _createWithdrawalOrder
    // fails; this check reads those facts on the monitor's cadence and decides
    // whether they warrant an alert. Watcher writes facts, monitor decides.
    try {
      const haltRows = await this.sql<{ key: string; value: string }[]>`
        SELECT key, value FROM bridge_state
        WHERE key IN (
          'gnosis_scan_halt_block',
          'gnosis_scan_halt_count',
          'gnosis_scan_halt_withdrawal_id',
          'gnosis_scan_halt_last_error'
        )
      `;
      const haltState: Record<string, string> = {};
      for (const row of haltRows) haltState[row.key] = row.value;
      const haltBlock = haltState['gnosis_scan_halt_block'] ?? null;
      const haltCount = parseInt(haltState['gnosis_scan_halt_count'] ?? '0', 10);
      const failingWithdrawalId = haltState['gnosis_scan_halt_withdrawal_id'] ?? null;
      const lastError = haltState['gnosis_scan_halt_last_error'] ?? null;
      alerts.push(
        ...checkScanHalt(
          haltBlock,
          isNaN(haltCount) ? 0 : haltCount,
          this.config.gnosisScanHaltAlertThreshold,
          failingWithdrawalId,
          lastError,
          checkedAt,
        ),
      );
    } catch (err) {
      console.error('[solvency-monitor] scan-halt state read failed:', err);
    }

    // ── Chain liveness ──────────────────────────────────────────────────────
    if (chainIsStalled) {
      const mins = Math.round((chainTipAgeSec ?? 0) / 60);
      alerts.push({
        level: 'warning',
        type: 'CHAIN_STALLED',
        timestamp: checkedAt,
        message:
          `No new Dobbscoin block for ${mins} minutes. Deposits cannot gain confirmations ` +
          `while this holds — (BOB) has a single miner, so this usually means mining has ` +
          `stopped rather than the bridge failing.`,
        data: { chainTipAgeSec, thresholdMinutes: this.config.chainStallThresholdMinutes },
      });

      // Name the cause on the stuck-order page so it is actionable from the subject
      // line instead of needing an investigation at 4am.
      for (const alert of alerts) {
        if (alert.type !== 'STUCK_ORDERS') continue;
        alert.message += ` — chain has produced no block in ${mins} minutes, so this is ` +
          `almost certainly stalled confirmations rather than a bridge fault.`;
        alert.data = { ...alert.data, chainTipAgeSec, chainIsStalled: true };
      }
    }

    const now = Date.now();
    for (const alert of alerts) {
      const lastFired = this.alertCooldowns.get(alert.type) ?? 0;
      if (now - lastFired >= this.config.alertCooldownMs) {
        this.alertCooldowns.set(alert.type, now);
        await this.dispatcher.dispatch(alert);
      }
    }
  }

  async start(): Promise<void> {
    console.log('[solvency-monitor] started');
    while (true) {
      try { await this.poll(); }
      catch (err) { console.error('[solvency-monitor] poll error:', err); }
      await new Promise<void>((r) => setTimeout(r, this.config.monitorIntervalMs));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Seconds since the newest Dobbscoin block, or null if the tip is unreadable.
   *
   * This exists to tell "the bridge is broken" apart from "nobody is mining".
   * (BOB) has one miner; when he stops, blocks stop, confirmations stop, and every
   * in-flight deposit sits still — which looks identical to a bridge fault from the
   * outside. It cost an unexplained 03:59 STUCK_ORDERS page on 2026-08-27, where the
   * real story was a 12-hour block gap.
   */
  private async _readChainTipAgeSec(): Promise<number | null> {
    if (!this.rpc) return null;
    try {
      const height = await this.rpc.call<number>('getblockcount');
      const hash   = await this.rpc.call<string>('getblockhash', [height]);
      const block  = await this.rpc.call<{ time: number }>('getblock', [hash]);
      return Math.max(0, Math.floor(Date.now() / 1000) - block.time);
    } catch (err) {
      console.error('[solvency-monitor] chain tip read failed:', err);
      return null;
    }
  }

  /**
   * Read wBOB totalSupply, reporting WHERE the number came from.
   *
   * The caller needs the provenance, not just the value: a DB estimate standing in
   * for a failed chain read must not be fed into the solvency verdict as though it
   * were chain truth. See SolvencySnapshot.supplyIsStale.
   */
  private async _readWBobSupply(): Promise<{ supply: bigint; source: 'chain' | 'db-estimate' }> {
    if (this.config.wBobAddress) {
      try {
        const supply = await this.publicClient.readContract({
          address: this.config.wBobAddress as ViemAddress,
          abi: [TOTAL_SUPPLY_ABI],
          functionName: 'totalSupply',
        }) as bigint;
        return { supply, source: 'chain' };
      } catch (err) {
        console.error('[solvency-monitor] chain totalSupply read FAILED — solvency verdict withheld this cycle:', err);
      }
    }
    return { supply: await this._dbWBobSupply(), source: 'db-estimate' };
  }

  /**
   * Estimate wBOB supply from DB:
   *   inbound COMPLETED amounts − outbound COMPLETED amounts.
   * This diverges from chain state if mints/burns happen outside the bridge,
   * but is always available without a chain RPC call.
   */
  private async _dbWBobSupply(): Promise<bigint> {
    const rows = await this.sql<{ supply: bigint }[]>`
      SELECT (
        COALESCE((
          SELECT SUM(amount_sat)
          FROM bridge_orders
          WHERE order_type = 'inbound' AND state = 'COMPLETED'
        ), 0)
        -
        COALESCE((
          SELECT SUM(amount_sat)
          FROM bridge_orders
          WHERE order_type = 'outbound' AND state = 'COMPLETED'
        ), 0)
      )::bigint AS supply
    `;
    const supply = rows[0]!.supply;
    return supply < 0n ? 0n : supply;
  }
}
