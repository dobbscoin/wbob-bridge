/**
 * Shared types for the Phase 8 solvency monitor.
 */

export type AlertLevel = 'critical' | 'warning' | 'info';

export type AlertType =
  | 'SOLVENCY_BREACH'     // wBOB supply > UTXO pool (bridge underwater)
  | 'SOLVENCY_RECOVERED'  // previously breached, now back above 1:1
  | 'LOW_UTXO_POOL'       // UTXO pool below configurable warning threshold
  | 'STUCK_ORDERS'        // one or more orders have not advanced state in too long
  | 'DRIP_WALLET_LOW'     // gas-drip hot wallet xDAI balance below low-water mark
  | 'DRIP_WALLET_DRY'     // gas-drip hot wallet has < drip amount; users being skipped
  | 'GNOSIS_SCAN_HALTED'; // log-scan stuck on a failing event past consecutive-poll threshold

export interface Alert {
  level: AlertLevel;
  type: AlertType;
  timestamp: string;
  message: string;
  data: Record<string, unknown>;
}

export interface SolvencySnapshot {
  checkedAt: string;
  /** wBOB totalSupply in satoshis (from chain if address configured, else DB estimate). */
  wBobSupplySat: bigint;
  /** Sum of bridge_utxos with status='available'. */
  utxoPoolSat: bigint;
  /**
   * Sum of fee_sat across broadcast/confirmed payouts. The bridge subsidises
   * Dobbscoin network fees on withdrawals, so this amount has left the pool
   * but never left wBOB supply. Solvency math adds it back to the pool side.
   */
  cumulativeFeesPaidSat: bigint;
  /** Sum of amount_sat on non-terminal outbound orders. */
  pendingPayoutsSat: bigint;
  /** (utxoPoolSat + cumulativeFeesPaidSat) / wBobSupplySat. 1 = exactly covered. */
  coverageRatio: number;
  /** True iff utxoPoolSat + cumulativeFeesPaidSat >= wBobSupplySat. */
  isSolvent: boolean;
  /** Number of orders stuck in non-terminal state past the configured threshold. */
  stuckOrderCount: number;
}
