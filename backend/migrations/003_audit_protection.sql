-- ============================================================================
-- Migration 003 — Enforce append-only audit_events
-- ============================================================================
-- Prevents UPDATE and DELETE on audit_events at the database level.
-- Even a compromised service account cannot alter historical records.
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_events_no_mutate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'audit_events is append-only: % operations are not permitted',
        TG_OP;
END;
$$;

CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();

CREATE TRIGGER trg_audit_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();

-- Prevent TRUNCATE too (requires superuser to bypass anyway, but belt-and-suspenders)
CREATE TRIGGER trg_audit_no_truncate
    BEFORE TRUNCATE ON audit_events
    EXECUTE FUNCTION audit_events_no_mutate();

-- ─── updated_at auto-maintenance ────────────────────────────────────────────
-- Automatically bump updated_at on mutable tables so we don't have to remember
-- to set it in every UPDATE statement.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON bridge_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_deposits_updated_at
    BEFORE UPDATE ON source_deposits
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_mints_updated_at
    BEFORE UPDATE ON mint_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_withdrawals_updated_at
    BEFORE UPDATE ON withdrawal_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payouts_updated_at
    BEFORE UPDATE ON payouts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
