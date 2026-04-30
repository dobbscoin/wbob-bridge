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
  parseAbiItem,
  type Address as ViemAddress,
} from 'viem';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import type { BackendConfig } from '../config.js';
import type { SolvencySnapshot, AlertType } from './types.js';
import { checkSolvency, checkStuckOrders, buildAlerts, checkDripWalletBalance } from './checks.js';
import { AlertDispatcher } from './webhook.js';
import type { DripSender } from '../executor/drip-sender.js';

const TOTAL_SUPPLY_ABI = parseAbiItem('function totalSupply() view returns (uint256)');

// Terminal states that do not count as "stuck".
const TERMINAL_STATES = `('COMPLETED', 'FAILED', 'MANUAL_REVIEW')`;

export class SolvencyMonitor {
  private readonly publicClient;
  private readonly dispatcher: AlertDispatcher;
  private lastSnapshot: SolvencySnapshot | null = null;
  /** Epoch-ms of the last dispatch per alert type (for cooldown). */
  private readonly alertCooldowns = new Map<AlertType, number>();

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
    private readonly dripSender: DripSender | null = null,
  ) {
    this.publicClient = createPublicClient({
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
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

    // 1. wBOB supply — prefer chain, fall back to DB
    const wBobSupplySat = await this._readWBobSupply();

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
    };

    // 6. Persist (cap coverageRatio at 999999 for the NUMERIC column)
    // Cast bigint → string because the postgres driver's TS types don't accept bigint
    // in tagged template literals (though the BigInt type registration handles it at runtime).
    const ratioStored = Math.min(coverageRatio, 999_999);
    await this.sql`
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
    const previouslySolvent = this.lastSnapshot?.isSolvent ?? null;
    this.lastSnapshot = snapshot;

    const alerts = buildAlerts(
      snapshot,
      previouslySolvent,
      BigInt(this.config.lowUtxoThresholdSat),
    );

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

  /** Read wBOB totalSupply from Gnosis, falling back to DB estimate on error. */
  private async _readWBobSupply(): Promise<bigint> {
    if (this.config.wBobAddress) {
      try {
        const supply = await this.publicClient.readContract({
          address: this.config.wBobAddress as ViemAddress,
          abi: [TOTAL_SUPPLY_ABI],
          functionName: 'totalSupply',
        }) as bigint;
        return supply;
      } catch (err) {
        console.error('[solvency-monitor] chain totalSupply read failed, falling back to DB:', err);
      }
    }
    return this._dbWBobSupply();
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
