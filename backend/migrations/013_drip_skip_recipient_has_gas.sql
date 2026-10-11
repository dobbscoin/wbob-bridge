-- ============================================================================
-- Migration 013 — skip the gas drip when the recipient already has xDAI
-- ============================================================================
-- btcbob, 2026-10: "can we deny a drip if the wallet already has xdai?"
--
-- After a mint, the drip sender now reads the recipient's native xDAI balance
-- first. At or above DRIP_SKIP_IF_RECIPIENT_BALANCE_WEI (default: the drip
-- amount) it does not send, and records status 'recipient_has_gas' with the
-- balance it saw. That status is NOT terminal: the one-ever drip is not used
-- up, so a later mint drips if the wallet has run low by then.
--
-- Additive: one more allowed status value, one new column.

ALTER TABLE gas_drips DROP CONSTRAINT gas_drips_status_check;
ALTER TABLE gas_drips ADD CONSTRAINT gas_drips_status_check
    CHECK (status IN ('opted_in', 'opted_out', 'sent', 'failed', 'wallet_dry', 'recipient_has_gas'));

ALTER TABLE gas_drips
    ADD COLUMN recipient_balance_wei NUMERIC(78, 0);   -- balance seen at the last skip
