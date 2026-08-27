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
  | 'GNOSIS_SCAN_HALTED'   // log-scan stuck on a failing event past consecutive-poll threshold
  | 'SUPPLY_READ_STALE'    // chain totalSupply unreadable; solvency verdict withheld
  | 'CHAIN_STALLED';       // no new Dobbscoin block past threshold -- deposits cannot confirm

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
  /** Where wBobSupplySat came from on this cycle. */
  supplySource: 'chain' | 'db-estimate';
  /**
   * True when a chain read was expected (wBobAddress is configured) but failed,
   * leaving wBobSupplySat as a DB estimate.
   *
   * When this is set the solvency verdict is WITHHELD, not merely uncertain. The
   * DB estimate is derived from the same bridge_orders rows that feed the pool
   * side, so comparing the two can only ever confirm itself -- it would report
   * healthy no matter what the chain actually holds. No snapshot row is written
   * in this state; a gap in the history is honest, a self-confirming row is not.
   */
  supplyIsStale: boolean;
  /** Seconds since the newest Dobbscoin block, or null if the tip could not be read. */
  chainTipAgeSec: number | null;
  /**
   * True when the tip is older than chainStallThresholdMinutes. Deposits cannot
   * accrue confirmations while this holds, so orders WILL trip STUCK_ORDERS --
   * with the chain, not the bridge, as the cause.
   */
  chainIsStalled: boolean;
}
