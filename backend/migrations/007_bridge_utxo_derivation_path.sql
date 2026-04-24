-- Track which HD path a UTXO's address was derived from.
-- Deposits live on m/0/<hd_index>; change outputs on m/1/<hd_index>.
-- Without this, the signer can't tell which private key to use when spending
-- a UTXO, and the solvency monitor can't ingest change outputs as spendable.

ALTER TABLE bridge_utxos
  ADD COLUMN derivation_path text NOT NULL DEFAULT 'deposit'
  CHECK (derivation_path IN ('deposit', 'change'));

-- Index sequences are per-path: MAX(hd_index WHERE path='deposit')+1 for new
-- deposits (the quotes API), MAX(hd_index WHERE path='change')+1 for change.
CREATE INDEX idx_bridge_utxos_path_hd_index
  ON bridge_utxos(derivation_path, hd_index);
