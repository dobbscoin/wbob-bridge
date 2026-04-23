-- ============================================================================
-- Migration 006 — Phase 8: solvency monitoring snapshots
-- ============================================================================

-- ─── solvency_snapshots ─────────────────────────────────────────────────────
-- Stores periodic solvency check results.
-- The monitor service writes one row per poll tick and purges rows older than
-- 30 days so the table stays bounded.

CREATE TABLE solvency_snapshots (
    id                  BIGSERIAL     PRIMARY KEY,
    checked_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    wbob_supply_sat     BIGINT        NOT NULL,   -- wBOB totalSupply in sats
    utxo_pool_sat       BIGINT        NOT NULL,   -- sum of available bridge UTXOs
    pending_payouts_sat BIGINT        NOT NULL,   -- sum of outstanding withdrawal obligations
    coverage_ratio      NUMERIC(14,6) NOT NULL,   -- utxo_pool / wbob_supply (capped at 999999)
    is_solvent          BOOLEAN       NOT NULL,   -- utxo_pool_sat >= wbob_supply_sat
    stuck_order_count   INTEGER       NOT NULL DEFAULT 0
);

CREATE INDEX idx_solvency_snapshots_checked_at ON solvency_snapshots(checked_at DESC);
