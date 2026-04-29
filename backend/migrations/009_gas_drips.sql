-- gas_drips: one row per Gnosis recipient, ever.
--
-- Records both the user's drip-opt-in PREFERENCE and the OUTCOME of any
-- drip attempt. Single-row-per-recipient (PK on recipient_gnosis_address)
-- enforces "one drip per address, ever" with no application-level locking.
--
-- Status state machine:
--   opted_in   → user opted in at deposit-address allocation; drip pending first qualifying mint
--   opted_out  → user explicitly unchecked the checkbox; never drip
--   sent       → drip transaction confirmed on Gnosis; gnosis_tx_hash populated
--   failed     → drip transaction reverted or threw; do not retry; investigate
--   wallet_dry → drip wallet had insufficient balance at attempt time
--                (NOT a terminal state — eligible for retry once refilled)
--
-- The mint flow MUST NOT be blocked by drip failures of any kind.

CREATE TABLE gas_drips (
    recipient_gnosis_address  TEXT         PRIMARY KEY,
    status                    TEXT         NOT NULL
        CHECK (status IN ('opted_in', 'opted_out', 'sent', 'failed', 'wallet_dry')),
    order_id                  UUID         REFERENCES bridge_orders(id),
    amount_wei                NUMERIC(78, 0),
    gnosis_tx_hash            TEXT,
    error                     TEXT,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sent_at                   TIMESTAMPTZ
);

CREATE INDEX idx_gas_drips_status ON gas_drips(status);
