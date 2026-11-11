-- Review round 5 #2 (2026-11-06): at most one refund row per deposit output.
-- Rows were unique only per order_id, so a second order row for the same
-- Dobbscoin output could carry a second refund. The refund executor also
-- makes every refund SPEND that output, so even without this index two
-- refunds of one output can never both confirm; this stops the second row
-- from being created at all.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_refunds_outpoint
    ON deposit_refunds (deposit_txid, deposit_vout);
