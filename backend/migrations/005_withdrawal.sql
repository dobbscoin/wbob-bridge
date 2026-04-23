-- ============================================================================
-- Migration 005 — Phase 5: bridge UTXO pool + state tracking
-- ============================================================================

-- ─── bridge_utxos ───────────────────────────────────────────────────────────
-- Tracks Dobbscoin UTXOs held by the bridge (one per confirmed deposit).
-- Populated when a deposit reaches DEPOSIT_FINALIZED.
-- Consumed when the payout executor selects inputs for a withdrawal payout.

CREATE TABLE bridge_utxos (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID         NOT NULL REFERENCES bridge_orders(id),
    txid            TEXT         NOT NULL,
    vout            INTEGER      NOT NULL CHECK (vout >= 0),
    amount_sat      BIGINT       NOT NULL CHECK (amount_sat > 0),
    address         TEXT         NOT NULL,
    hd_index        INTEGER      NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'available'
                                 CHECK (status IN ('available', 'reserved', 'spent')),
    spent_payout_id UUID         REFERENCES payouts(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (txid, vout)
);

CREATE INDEX idx_bridge_utxos_status ON bridge_utxos(status);

-- ─── bridge_state ───────────────────────────────────────────────────────────
-- Key-value store for persistent watcher state (e.g. last processed block).

CREATE TABLE bridge_state (
    key        TEXT         PRIMARY KEY,
    value      TEXT         NOT NULL,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the Gnosis block cursor at 0; the event watcher will fast-forward
-- to the deployment block before entering its main loop.
INSERT INTO bridge_state (key, value) VALUES ('gnosis_last_block', '0');
