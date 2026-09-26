-- ============================================================================
-- Migration 011 — watcher block cursor
-- ============================================================================
-- Each watcher instance records the last Dobbscoin block it fully processed.
-- On startup it replays every block after this one before resuming normal
-- polling, so a deposit mined while the watcher was down or restarting is
-- still seen. Before this, a restarted watcher began at whatever the tip was
-- and never looked back (2026-06-18: two deposits mined during a 3-hour
-- outage were never ingested).
--
-- One row per watcher instance, keyed by its signer address (lowercase). The
-- three watchers each scan every block independently, so each keeps its own
-- position; a shared row would let one instance mark blocks done for another.
--
-- Written by the watcher only after a block's handler has finished, so a
-- crash can leave the cursor behind (the block is replayed, harmlessly) but
-- never ahead of the work.

CREATE TABLE watcher_cursors (
    watcher_id    TEXT         PRIMARY KEY,
    block_height  INTEGER      NOT NULL CHECK (block_height >= 0),
    block_hash    TEXT         NOT NULL,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
