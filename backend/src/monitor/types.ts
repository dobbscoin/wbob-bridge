/**
 * Shared types for the Phase 8 solvency monitor.
 */

export type AlertLevel = 'critical' | 'warning' | 'info';

export type AlertType =
  | 'SOLVENCY_BREACH'     // wBOB supply > UTXO pool (bridge underwater)
  | 'SOLVENCY_RECOVERED'  // previously breached, now back above 1:1
  | 'LOW_UTXO_POOL'       // UTXO pool below configurable warning threshold
  | 'STUCK_ORDERS';       // one or more orders have not advanced state in too long

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
  /** Sum of amount_sat on non-terminal outbound orders. */
  pendingPayoutsSat: bigint;
  /** utxoPoolSat / wBobSupplySat. 1 = exactly covered. */
  coverageRatio: number;
  /** True iff utxoPoolSat >= wBobSupplySat. */
  isSolvent: boolean;
  /** Number of orders stuck in non-terminal state past the configured threshold. */
  stuckOrderCount: number;
}
