/**
 * Pure, side-effect-free solvency check functions.
 *
 * These contain all the decision logic so they can be unit-tested without a
 * database or Gnosis RPC connection.
 */

import type { Alert, AlertType, SolvencySnapshot } from './types.js';

// ─── checkSolvency ────────────────────────────────────────────────────────────

export interface SolvencyResult {
  isSolvent: boolean;
  coverageRatio: number;
  deficitSat: bigint;
}

/**
 * Determine whether the bridge UTXO pool covers the total wBOB supply.
 *
 * The bridge subsidises Dobbscoin network fees on every withdrawal: a payout
 * sends the user the full burned amount and the fee comes out of the bridge's
 * own UTXO inputs. Cumulative paid fees therefore make the raw pool drift
 * below supply by exactly that amount, even though no funds are missing. We
 * add fees-paid to the pool side so the comparison reflects the funds the
 * operator has *committed*, not just the funds still on hand.
 *
 * @param wBobSupplySat        Total wBOB minted (satoshi units, from chain or DB).
 * @param utxoPoolSat          Sum of available bridge UTXOs (satoshi units).
 * @param cumulativeFeesPaidSat Sum of fee_sat across broadcast/confirmed payouts.
 */
export function checkSolvency(
  wBobSupplySat: bigint,
  utxoPoolSat: bigint,
  cumulativeFeesPaidSat: bigint = 0n,
): SolvencyResult {
  const effectivePoolSat = utxoPoolSat + cumulativeFeesPaidSat;
  const isSolvent   = effectivePoolSat >= wBobSupplySat;
  const deficitSat  = isSolvent ? 0n : wBobSupplySat - effectivePoolSat;
  // Guard against division by zero; if supply is 0 the bridge is trivially solvent.
  const coverageRatio = wBobSupplySat === 0n
    ? 1
    : Number(effectivePoolSat) / Number(wBobSupplySat);
  return { isSolvent, coverageRatio, deficitSat };
}

// ─── checkStuckOrders ────────────────────────────────────────────────────────

/**
 * Return the IDs of orders that have not advanced past a non-terminal state
 * in longer than `stuckThresholdMs`.
 *
 * @param orders            Non-terminal bridge orders with their last update time.
 * @param stuckThresholdMs  Age threshold in milliseconds.
 * @param nowMs             Current time in ms (injectable for testing).
 */
export function checkStuckOrders(
  orders: Array<{ id: string; state: string; updatedAt: Date }>,
  stuckThresholdMs: number,
  nowMs = Date.now(),
): string[] {
  return orders
    .filter((o) => nowMs - o.updatedAt.getTime() > stuckThresholdMs)
    .map((o) => o.id);
}

// ─── buildAlerts ─────────────────────────────────────────────────────────────

/**
 * Derive the set of alerts that should be considered for dispatch given the
 * current snapshot.  Callers apply cooldown logic before actually sending.
 *
 * @param snapshot             Current solvency snapshot.
 * @param previouslySolvent    Solvency of the prior snapshot (null = first run).
 * @param lowUtxoThresholdSat  Warn when the UTXO pool drops below this value.
 */
export function buildAlerts(
  snapshot: SolvencySnapshot,
  previouslySolvent: boolean | null,
  lowUtxoThresholdSat: bigint,
): Alert[] {
  const alerts: Alert[] = [];
  const ts = snapshot.checkedAt;

  // ── Solvency breach / recovery ────────────────────────────────────────────
  // Fees-paid is added to the pool side (operator-subsidized payout fees are a
  // committed obligation, not lost funds). A real breach now means the bridge
  // is under water beyond cumulative fees.
  const fees = snapshot.cumulativeFeesPaidSat;
  const effectivePool = snapshot.utxoPoolSat + fees;
  if (!snapshot.isSolvent) {
    const deficit = snapshot.wBobSupplySat - effectivePool;
    alerts.push({
      level: 'critical',
      type: 'SOLVENCY_BREACH',
      timestamp: ts,
      message:
        `Bridge undercollateralized: UTXO pool ${snapshot.utxoPoolSat} sat ` +
        `+ fees paid ${fees} sat = ${effectivePool} sat ` +
        `< wBOB supply ${snapshot.wBobSupplySat} sat ` +
        `(deficit ${deficit} sat, ratio ${snapshot.coverageRatio.toFixed(6)})`,
      data: {
        wBobSupplySat:         snapshot.wBobSupplySat.toString(),
        utxoPoolSat:           snapshot.utxoPoolSat.toString(),
        cumulativeFeesPaidSat: fees.toString(),
        effectivePoolSat:      effectivePool.toString(),
        deficitSat:            deficit.toString(),
        coverageRatio:         snapshot.coverageRatio,
      },
    });
  } else if (previouslySolvent === false) {
    // Transition from breach → solvent: send a recovery notice.
    alerts.push({
      level: 'info',
      type: 'SOLVENCY_RECOVERED',
      timestamp: ts,
      message:
        `Bridge solvency restored. ` +
        `Coverage ratio: ${snapshot.coverageRatio.toFixed(6)} ` +
        `(UTXO pool ${snapshot.utxoPoolSat} sat + fees paid ${fees} sat, ` +
        `supply ${snapshot.wBobSupplySat} sat)`,
      data: {
        utxoPoolSat:           snapshot.utxoPoolSat.toString(),
        cumulativeFeesPaidSat: fees.toString(),
        effectivePoolSat:      effectivePool.toString(),
        wBobSupplySat:         snapshot.wBobSupplySat.toString(),
        coverageRatio:         snapshot.coverageRatio,
      },
    });
  }

  // ── Low UTXO pool ─────────────────────────────────────────────────────────
  if (snapshot.utxoPoolSat < lowUtxoThresholdSat) {
    alerts.push({
      level: 'warning',
      type: 'LOW_UTXO_POOL',
      timestamp: ts,
      message:
        `UTXO pool critically low: ${snapshot.utxoPoolSat} sat ` +
        `(threshold: ${lowUtxoThresholdSat} sat)`,
      data: {
        utxoPoolSat:   snapshot.utxoPoolSat.toString(),
        thresholdSat:  lowUtxoThresholdSat.toString(),
      },
    });
  }

  // ── Stuck orders ─────────────────────────────────────────────────────────
  // (drip-wallet alerts are produced by checkDripWalletBalance, not here, since
  //  they don't fit in the SolvencySnapshot.)
  if (snapshot.stuckOrderCount > 0) {
    alerts.push({
      level: 'warning',
      type: 'STUCK_ORDERS',
      timestamp: ts,
      message:
        `${snapshot.stuckOrderCount} order(s) stuck in non-terminal state ` +
        `(no state change past threshold)`,
      data: { stuckOrderCount: snapshot.stuckOrderCount },
    });
  }

  return alerts;
}

// ─── checkDripWalletBalance ──────────────────────────────────────────────────

/**
 * Decide whether the drip wallet's balance warrants an alert.
 *
 *   balance < dripAmountWei      → DRIP_WALLET_DRY (critical — users skipped)
 *   balance < lowWaterMarkWei    → DRIP_WALLET_LOW (warning — refill soon)
 *   otherwise                    → no alert
 */
export function checkDripWalletBalance(
  walletAddress: string,
  balanceWei: bigint,
  dripAmountWei: bigint,
  lowWaterMarkWei: bigint,
  checkedAt: string = new Date().toISOString(),
): Alert[] {
  const alerts: Alert[] = [];
  if (balanceWei < dripAmountWei) {
    alerts.push({
      level: 'critical',
      type: 'DRIP_WALLET_DRY',
      timestamp: checkedAt,
      message:
        `Drip wallet ${walletAddress} balance ${balanceWei} wei is below the ` +
        `drip amount ${dripAmountWei} wei. New users opted-in for a drip ` +
        `are being skipped on mint until the wallet is refilled.`,
      data: {
        walletAddress,
        balanceWei: balanceWei.toString(),
        dripAmountWei: dripAmountWei.toString(),
      },
    });
  } else if (balanceWei < lowWaterMarkWei) {
    alerts.push({
      level: 'warning',
      type: 'DRIP_WALLET_LOW',
      timestamp: checkedAt,
      message:
        `Drip wallet ${walletAddress} balance ${balanceWei} wei is below the ` +
        `low-water mark ${lowWaterMarkWei} wei. Refill soon to avoid stalling ` +
        `new-user onboarding.`,
      data: {
        walletAddress,
        balanceWei: balanceWei.toString(),
        lowWaterMarkWei: lowWaterMarkWei.toString(),
      },
    });
  }
  return alerts;
}

// ─── checkScanHalt ───────────────────────────────────────────────────────────

/**
 * Decide whether the Gnosis log scan has been halted at a single block for
 * long enough to alert. The watcher writes halt-state into `bridge_state` on
 * every poll where it fails to process an event; this check is the
 * independent observer that escalates a sustained halt to a real alert.
 *
 * @param haltBlock              Block where the watcher is currently stuck,
 *                               or null/empty if not halted.
 * @param haltCount              Consecutive polls halted at `haltBlock`.
 * @param threshold              Polls of halt required before alerting.
 * @param failingWithdrawalId    The withdrawalId that's failing, if known.
 * @param lastError              Last underlying error string from the watcher,
 *                               if recorded. NEVER contains secrets — it's
 *                               whatever the watcher chose to persist.
 * @param checkedAt              Snapshot timestamp.
 */
export function checkScanHalt(
  haltBlock: string | null,
  haltCount: number,
  threshold: number,
  failingWithdrawalId: string | null,
  lastError: string | null,
  checkedAt: string = new Date().toISOString(),
): Alert[] {
  if (!haltBlock || haltCount < threshold) return [];
  const idClause = failingWithdrawalId
    ? ` (failing withdrawalId=${failingWithdrawalId})`
    : '';
  const errClause = lastError ? ` Last error: ${lastError}` : '';
  return [{
    level: 'critical',
    type: 'GNOSIS_SCAN_HALTED',
    timestamp: checkedAt,
    message:
      `Gnosis log scan has been halted at block ${haltBlock} for ` +
      `${haltCount} consecutive polls (threshold ${threshold})${idClause}.` +
      errClause,
    data: {
      haltBlock,
      haltCount,
      threshold,
      failingWithdrawalId,
      lastError,
    },
  }];
}
