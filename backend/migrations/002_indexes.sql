-- ============================================================================
-- Migration 002 — Indexes for common query patterns
-- ============================================================================

-- bridge_orders: look up by state (polling workers) and by user address
CREATE INDEX idx_bridge_orders_state        ON bridge_orders (state);
CREATE INDEX idx_bridge_orders_order_type   ON bridge_orders (order_type);
CREATE INDEX idx_bridge_orders_gnosis_addr  ON bridge_orders (user_gnosis_address)
    WHERE user_gnosis_address IS NOT NULL;
CREATE INDEX idx_bridge_orders_dob_addr     ON bridge_orders (user_dobbscoin_address)
    WHERE user_dobbscoin_address IS NOT NULL;
CREATE INDEX idx_bridge_orders_updated      ON bridge_orders (updated_at DESC);

-- source_deposits: look up by txid+vout (watcher dedup) and by address (watcher)
CREATE INDEX idx_source_deposits_order_id   ON source_deposits (order_id);
CREATE INDEX idx_source_deposits_txid_vout  ON source_deposits (txid, vout)
    WHERE txid IS NOT NULL;
CREATE INDEX idx_source_deposits_address    ON source_deposits (deposit_address);
-- pending deposits needing confirmation updates
CREATE INDEX idx_source_deposits_pending    ON source_deposits (confirmations, updated_at)
    WHERE txid IS NOT NULL AND finalized_at IS NULL;

-- mint_requests: look up by gnosis tx (confirmation watcher)
CREATE INDEX idx_mint_requests_order_id      ON mint_requests (order_id);
CREATE INDEX idx_mint_requests_gnosis_tx     ON mint_requests (gnosis_tx_hash)
    WHERE gnosis_tx_hash IS NOT NULL;
-- pending mints that haven't collected enough signatures yet
CREATE INDEX idx_mint_requests_pending_sigs  ON mint_requests (signature_count, updated_at)
    WHERE gnosis_tx_hash IS NULL;

-- withdrawal_requests: look up by withdrawal_id (event listener) and burn tx
CREATE INDEX idx_withdrawals_order_id         ON withdrawal_requests (order_id);
CREATE INDEX idx_withdrawals_withdrawal_id    ON withdrawal_requests (withdrawal_id);
CREATE INDEX idx_withdrawals_burn_tx          ON withdrawal_requests (burn_tx_hash)
    WHERE burn_tx_hash IS NOT NULL;
CREATE INDEX idx_withdrawals_sender           ON withdrawal_requests (sender_address);

-- payouts: look up by txid (Dobbscoin watcher)
CREATE INDEX idx_payouts_withdrawal_id    ON payouts (withdrawal_request_id);
CREATE INDEX idx_payouts_txid             ON payouts (txid) WHERE txid IS NOT NULL;
CREATE INDEX idx_payouts_pending          ON payouts (confirmations, updated_at)
    WHERE txid IS NOT NULL AND confirmed_at IS NULL;

-- audit_events: look up by order (history view) — id is already PK/indexed
CREATE INDEX idx_audit_order_id   ON audit_events (order_id, id);
CREATE INDEX idx_audit_event_type ON audit_events (event_type, created_at DESC);
