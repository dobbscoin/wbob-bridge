-- Review round 11 (2026-11-11): one Dobbscoin output may be recorded as a
-- deposit only once. The legacy quote flow (pass A1) had no "(txid, vout)
-- already recorded" check, so one output could back two orders with two
-- depositIds, and the V1 contract dedups on depositId only. Live data had 0
-- duplicates when this was added.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_deposits_outpoint
    ON source_deposits (txid, vout) WHERE txid IS NOT NULL;
