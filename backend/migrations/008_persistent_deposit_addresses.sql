-- Persistent deposit addresses: each Gnosis recipient has one (or more) forever-
-- tracked Dobbscoin address(es). Removes the "exact amount" / quote-expiry UX trap.
--
-- Users can send any amount to their address from any wallet, any number of
-- times — each confirmed deposit auto-creates a bridge_orders row and mints
-- the actual received amount to the recipient.

CREATE TABLE deposit_addresses (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_gnosis_address  text      NOT NULL,
    source_chain_name         text      NOT NULL,
    dobbscoin_address         text      NOT NULL UNIQUE,
    hd_index                  integer   NOT NULL UNIQUE,
    created_at                timestamptz NOT NULL DEFAULT now()

    -- A recipient may have multiple addresses (legacy-flow leftovers +
    -- the current one). The `GET /v1/deposit-address` endpoint returns the
    -- most-recently-created row; the watcher matches deposits to any of them.
);

CREATE INDEX idx_deposit_addresses_recipient
    ON deposit_addresses(recipient_gnosis_address, source_chain_name, created_at DESC);
CREATE INDEX idx_deposit_addresses_address ON deposit_addresses(dobbscoin_address);

-- Backfill historical addresses so the watcher's new "any deposit to any
-- tracked address" logic continues to see addresses that were assigned via
-- the legacy quote flow.
INSERT INTO deposit_addresses (recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index, created_at)
SELECT DISTINCT
    bo.user_gnosis_address,
    sd.source_chain_name,
    sd.deposit_address,
    bu.hd_index,
    sd.created_at
FROM source_deposits sd
JOIN bridge_orders bo ON bo.id = sd.order_id
JOIN bridge_utxos  bu ON bu.order_id = bo.id
                     AND bu.txid = sd.txid
                     AND bu.vout = sd.vout
                     AND bu.derivation_path = 'deposit'
WHERE bo.order_type = 'inbound'
ON CONFLICT DO NOTHING;
