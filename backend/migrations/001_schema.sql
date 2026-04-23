-- ============================================================================
-- Migration 001 — Core bridge schema
-- ============================================================================
-- All monetary values are stored in satoshi units (INT8, 8 decimal places).
-- UUIDs use gen_random_uuid() (requires pgcrypto or pg >=13 built-in).
-- TIMESTAMPTZ everywhere — never plain TIMESTAMP.
-- ============================================================================

-- ─── bridge_orders ──────────────────────────────────────────────────────────
-- One row per user-initiated action (inbound deposit or outbound withdrawal).
-- state tracks the current FSM position; transitions are recorded in audit_events.

CREATE TABLE bridge_orders (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_type           TEXT         NOT NULL CHECK (order_type IN ('inbound', 'outbound')),
    state                TEXT         NOT NULL,
    user_gnosis_address  TEXT,        -- Gnosis recipient (inbound) or sender (outbound)
    user_dobbscoin_address TEXT,      -- Dobbscoin source (inbound) or destination (outbound)
    amount_sat           BIGINT       CHECK (amount_sat IS NULL OR amount_sat > 0),
    fee_sat              BIGINT       CHECK (fee_sat IS NULL OR fee_sat >= 0),
    expires_at           TIMESTAMPTZ, -- quote expiry (inbound only)
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── source_deposits ────────────────────────────────────────────────────────
-- Tracks a Dobbscoin UTXO deposit through its confirmation lifecycle.
-- deposit_id is the deterministic keccak256 ID from the brief; stored as BYTEA
-- to match the bytes32 on-chain key exactly.

CREATE TABLE source_deposits (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         UUID         NOT NULL REFERENCES bridge_orders(id),
    deposit_id       BYTEA        NOT NULL UNIQUE, -- keccak256 bytes32
    deposit_address  TEXT         NOT NULL,         -- assigned Dobbscoin address
    txid             TEXT,                          -- Dobbscoin txid (hex)
    vout             INTEGER      CHECK (vout IS NULL OR vout >= 0),
    amount_sat       BIGINT       CHECK (amount_sat IS NULL OR amount_sat > 0),
    confirmations    INTEGER      NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    block_height     INTEGER      CHECK (block_height IS NULL OR block_height >= 0),
    block_hash       TEXT,
    seen_mempool_at  TIMESTAMPTZ,
    confirmed_at     TIMESTAMPTZ,  -- crossed CONFIRMATION_THRESHOLD
    finalized_at     TIMESTAMPTZ,  -- crossed REORG_DEPTH threshold (safe to mint)
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── mint_requests ──────────────────────────────────────────────────────────
-- One row per inbound order that reaches MINT_AUTH_CREATED.
-- mint_authorization stores the full MintAuthorization struct as JSON.
-- signatures is a JSON array of hex-encoded ECDSA signatures collected so far.

CREATE TABLE mint_requests (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id             UUID         NOT NULL UNIQUE REFERENCES bridge_orders(id),
    deposit_id           BYTEA        NOT NULL UNIQUE REFERENCES source_deposits(deposit_id),
    recipient_address    TEXT         NOT NULL,  -- Gnosis address
    amount_sat           BIGINT       NOT NULL CHECK (amount_sat > 0),
    mint_authorization   JSONB,                  -- serialized MintAuthorization
    signatures           JSONB        NOT NULL DEFAULT '[]'::JSONB,
    signature_count      SMALLINT     NOT NULL DEFAULT 0 CHECK (signature_count >= 0),
    gnosis_tx_hash       TEXT,                   -- executeMint() tx hash
    gnosis_block_number  BIGINT,
    confirmed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── withdrawal_requests ────────────────────────────────────────────────────
-- Populated when a WithdrawalRequested event is observed on Gnosis.
-- withdrawal_id is the uint256 from the event (stored as NUMERIC to fit uint256).

CREATE TABLE withdrawal_requests (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id             UUID         NOT NULL UNIQUE REFERENCES bridge_orders(id),
    withdrawal_id        NUMERIC      NOT NULL UNIQUE, -- uint256 from event
    sender_address       TEXT         NOT NULL,
    dobbscoin_address    TEXT         NOT NULL,
    amount_sat           BIGINT       NOT NULL CHECK (amount_sat > 0),
    user_nonce           BIGINT       NOT NULL CHECK (user_nonce >= 0),
    burn_tx_hash         TEXT,
    burn_block_number    BIGINT,
    burn_confirmed_at    TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── payouts ────────────────────────────────────────────────────────────────
-- One Dobbscoin payout transaction per outbound order.

CREATE TABLE payouts (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    withdrawal_request_id   UUID         NOT NULL UNIQUE REFERENCES withdrawal_requests(id),
    dobbscoin_address        TEXT         NOT NULL,
    amount_sat              BIGINT       NOT NULL CHECK (amount_sat > 0),
    fee_sat                 BIGINT       CHECK (fee_sat IS NULL OR fee_sat >= 0),
    txid                    TEXT,        -- Dobbscoin payout txid
    vout                    INTEGER      CHECK (vout IS NULL OR vout >= 0),
    confirmations           INTEGER      NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    broadcast_at            TIMESTAMPTZ,
    confirmed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── audit_events ───────────────────────────────────────────────────────────
-- Append-only log of every state transition and notable event.
-- BIGSERIAL id is strictly monotonic — never reused, never updated.
-- Row-level security and trigger (migration 003) enforce the append-only contract.

CREATE TABLE audit_events (
    id          BIGSERIAL    PRIMARY KEY,
    order_id    UUID         NOT NULL REFERENCES bridge_orders(id),
    event_type  TEXT         NOT NULL,  -- 'STATE_TRANSITION' | 'SIGNER_ADDED' | etc.
    from_state  TEXT,                   -- NULL for initial creation events
    to_state    TEXT         NOT NULL,
    actor       TEXT,                   -- service name or address that triggered
    metadata    JSONB,                  -- arbitrary context (txid, sigs, error, etc.)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    -- NO updated_at — this table is append-only by design
);
