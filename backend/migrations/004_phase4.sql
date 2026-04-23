-- ============================================================================
-- Migration 004 — Phase 4: HD wallet + mint executor columns
-- ============================================================================

-- ─── source_deposits ────────────────────────────────────────────────────────
-- At quote creation we assign a deposit address before any tx exists,
-- so deposit_id (computed from txid+vout+amount) can't be known yet.
ALTER TABLE source_deposits ALTER COLUMN deposit_id DROP NOT NULL;

-- Track which HD wallet index produced this deposit address.
ALTER TABLE source_deposits ADD COLUMN hd_index INTEGER;

-- Source chain name is needed to reproduce the depositId later.
ALTER TABLE source_deposits
  ADD COLUMN source_chain_name TEXT NOT NULL DEFAULT 'dobbscoin-mainnet';

-- ─── mint_requests ──────────────────────────────────────────────────────────
-- Mint executor stores the nonce and deadline it used when building the auth.
-- All watchers must sign the exact same struct, so these are written once.
ALTER TABLE mint_requests ADD COLUMN mint_nonce  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE mint_requests ADD COLUMN deadline    BIGINT NOT NULL DEFAULT 0;
