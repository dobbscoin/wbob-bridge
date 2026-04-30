-- ============================================================================
-- Migration 010 — fee-aware solvency snapshots
-- ============================================================================
-- The bridge subsidises Dobbscoin network fees on every withdrawal: a payout
-- sends the user the full burned amount and the fee comes out of the bridge's
-- own UTXO inputs. Cumulative paid fees made the raw `utxo_pool_sat` drift
-- below `wbob_supply_sat` by exactly that amount — see #SOLVENCY_BREACH alert
-- on 2026-04-29 (deficit 2260 sat, ratio 0.99999999984).
--
-- Adding the cumulative fees-paid term lets the monitor compute solvency as
--   (utxo_pool_sat + cumulative_fees_paid_sat) >= wbob_supply_sat
-- which reflects funds the operator has *committed* (paid as miner fee), not
-- just funds still on hand.

ALTER TABLE solvency_snapshots
    ADD COLUMN cumulative_fees_paid_sat BIGINT NOT NULL DEFAULT 0;

-- Drop the default once the column exists; new inserts always supply a value.
ALTER TABLE solvency_snapshots
    ALTER COLUMN cumulative_fees_paid_sat DROP DEFAULT;
