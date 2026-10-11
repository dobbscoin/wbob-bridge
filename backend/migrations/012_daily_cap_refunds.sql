-- ============================================================================
-- Migration 012 — daily mint cap: partial mints and refunds of the excess
-- ============================================================================
-- wBOB enforces a daily mint limit (WBob.dailyMintLimit, 1,000,000 wBOB at the
-- time of writing, window aligned to 00:00 UTC). Before this migration a
-- deposit larger than what was left of the day's limit made executeMint revert
-- at gas estimation forever: the 1-hour authorization expired long before the
-- reset, the order sat in MINT_AUTH_CREATED, and the (BOB) stayed locked.
--
-- Now the mint executor splits each finalized deposit when it creates the
-- authorization: it mints what fits under the cap and refunds the rest to the
-- address that sent it. Everything here is additive.
--
--   mint_requests     the split decision, the authorization's regeneration
--                     count, and the last reason a submit was refused.
--   deposit_refunds   one row per inbound order that has an excess.
--   bridge_utxos      spent_refund_id: which refund consumed a UTXO
--                     (spent_payout_id points at payouts, which needs a
--                     withdrawal_request, so a refund cannot use it).
-- ============================================================================

-- ─── mint_requests ──────────────────────────────────────────────────────────
-- amount_sat keeps its meaning: the amount the watchers sign and executeMint
-- mints. deposit_amount_sat is what arrived; the difference is refunded.
-- NULL deposit_amount_sat = a row created before this migration (mint == deposit).

ALTER TABLE mint_requests
    ADD COLUMN deposit_amount_sat   BIGINT CHECK (deposit_amount_sat IS NULL OR deposit_amount_sat > 0),
    ADD COLUMN cap_decision         JSONB,        -- chain cap state + reservations the split was decided on
    ADD COLUMN regenerated_count    INTEGER NOT NULL DEFAULT 0 CHECK (regenerated_count >= 0),
    ADD COLUMN last_submit_error    TEXT,         -- last reason executeMint simulation/submission was refused
    ADD COLUMN last_submit_error_at TIMESTAMPTZ;

-- ─── deposit_refunds ────────────────────────────────────────────────────────
-- Status:
--   queued           decided; sender lookup and/or signing still to come
--   signed           refund tx built and signed, inputs reserved
--   broadcast        accepted by the Dobbscoin node; inputs spent, change ingested
--   confirmed        PAYOUT_MIN_CONFIRMATIONS reached
--   needs_attention  the bridge will not guess (sender undeterminable, build or
--                    broadcast refused). Operator fixes refund_address / resets
--                    status to 'queued' by hand.
--   too_small        excess <= network fee + dust; recorded, no tx built. The
--                    coins stay in the bridge pool.
--
-- Fee policy: the refund pays its own network fee (amount_sat = excess_sat −
-- part of fee_sat). bridge_fee_sat is the part of fee_sat the bridge paid on
-- top of the excess (a change remainder at or under dust is folded into the
-- fee). The solvency monitor adds it to cumulative fees paid, exactly like
-- payouts' fee_sat, so a refund never reads as an unbacked outflow.

CREATE TABLE deposit_refunds (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID         NOT NULL UNIQUE REFERENCES bridge_orders(id),
    deposit_txid       TEXT         NOT NULL,
    deposit_vout       INTEGER      NOT NULL CHECK (deposit_vout >= 0),
    deposit_amount_sat BIGINT       NOT NULL CHECK (deposit_amount_sat > 0),
    mint_amount_sat    BIGINT       NOT NULL CHECK (mint_amount_sat >= 0),
    excess_sat         BIGINT       NOT NULL CHECK (excess_sat > 0),
    refund_address     TEXT,                    -- NULL until the sender is resolved
    sender_detail      JSONB,                   -- how the sender was resolved (input count, script type…)
    status             TEXT         NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'signed', 'broadcast', 'confirmed',
                                         'needs_attention', 'too_small')),
    reason             TEXT,                    -- why needs_attention / too_small
    amount_sat         BIGINT       CHECK (amount_sat IS NULL OR amount_sat > 0),  -- paid to sender
    fee_sat            BIGINT       CHECK (fee_sat IS NULL OR fee_sat >= 0),        -- whole tx fee
    bridge_fee_sat     BIGINT       NOT NULL DEFAULT 0 CHECK (bridge_fee_sat >= 0),
    signed_hex         TEXT,
    txid               TEXT,                    -- set at signing (computed); broadcast_at says it went out
    change_sat         BIGINT       CHECK (change_sat IS NULL OR change_sat >= 0),
    change_address     TEXT,
    change_index       INTEGER      CHECK (change_index IS NULL OR change_index >= 0),
    confirmations      INTEGER      NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    split_alerted_at   TIMESTAMPTZ,
    signed_at          TIMESTAMPTZ,
    broadcast_at       TIMESTAMPTZ,
    confirmed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CHECK (excess_sat + mint_amount_sat = deposit_amount_sat)
);

CREATE INDEX idx_deposit_refunds_status ON deposit_refunds (status);
CREATE INDEX idx_deposit_refunds_txid   ON deposit_refunds (txid) WHERE txid IS NOT NULL;

CREATE TRIGGER trg_deposit_refunds_updated_at
    BEFORE UPDATE ON deposit_refunds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── bridge_utxos ───────────────────────────────────────────────────────────

ALTER TABLE bridge_utxos
    ADD COLUMN spent_refund_id UUID REFERENCES deposit_refunds(id);

CREATE INDEX idx_bridge_utxos_spent_refund ON bridge_utxos (spent_refund_id)
    WHERE spent_refund_id IS NOT NULL;
