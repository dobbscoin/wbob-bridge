/**
 * Independent pre-signing check (2026-11-05 review).
 *
 * Each signer asks ITS OWN node about the deposit tx at the moment of signing.
 * The mint_requests row alone is not evidence. Returns null when it is safe to
 * sign, otherwise a human-readable reason to refuse.
 *
 * Checks:
 *   - the node knows the tx and shows it at >= finalConfirmations in the active chain
 *   - the recorded deposit address IS the bridge's own address at hd_index, derived
 *     from HD_WALLET_XPUB in this watcher's environment (never trusted from the DB)
 *   - output `vout` exists, pays that address, and is worth at least the amount
 *     about to be authorized (a daily-cap split mints less than the deposit)
 *   - the depositId in the row is exactly what computeDepositId gives for the
 *     node's view of that output plus the row's recipient
 *   - (2026-11-12, watcher split) the recipient about to be authorized is the one
 *     registered for this deposit address in deposit_addresses (row keyed by
 *     hd_index, whose dobbscoin_address must be the recorded deposit address).
 *     Watchers on other boxes get INSERT on bridge_orders/source_deposits, so a
 *     compromised one could otherwise record a real deposit with its own
 *     recipient and a matching fresh depositId. This holds only while NO watcher
 *     login can write deposit_addresses (only the backend API inserts there).
 */

import { computeDepositId } from '../deposits/deposit-id.js';
import type { TxChainStatus } from '../deposits/block-handler.js';
import type { Address } from '@wbob/shared';

export interface MintCheckRow {
  txid: string;
  vout: number;
  deposit_address: string;
  source_chain_name: string;
  recipient_address: string;
  amount_sat: bigint | string | number;
  deposit_id_hex: string;
  /** The bridge's address at this row's hd_index, derived from the watcher's xpub (null = could not derive). */
  expected_deposit_address: string | null;
  /** source_deposits.amount_sat: the deposit value the bridge recorded (null on legacy rows). */
  deposit_value_sat?: bigint | string | number | null;
  /** V2: the recorded deposit value is required and must equal the node's (it is signed as sourceValue). */
  require_deposit_value?: boolean;
  /**
   * V2 cutover floor (review round 6 #2): the deposit's block height on our node
   * must be >= minHeight, unless "txid:vout" is in allowed.
   */
  cutover_floor?: { minHeight: number; allowed: Set<string>; depositHeight: number | null } | null;
  /** deposit_addresses.recipient_gnosis_address for this row's hd_index (null = no such row). */
  registered_recipient: string | null;
  /** deposit_addresses.dobbscoin_address for this row's hd_index (null = no such row). */
  registered_deposit_address: string | null;
}

export function checkMintAgainstNode(
  row: MintCheckRow,
  st: TxChainStatus | null,
  finalConfirmations: number,
): string | null {
  if (st === null) return 'node does not know the tx';
  if (st.confirmations < finalConfirmations) {
    return `node shows ${st.confirmations} confirmations (< ${finalConfirmations})`;
  }
  if (row.cutover_floor) {
    const f = row.cutover_floor;
    if (f.depositHeight === null) return 'cannot read the deposit block height (needed for the V2 cutover floor)';
    if (f.depositHeight < f.minHeight && !f.allowed.has(`${row.txid.replace(/^0x/, '').toLowerCase()}:${row.vout}`)) {
      return `deposit confirmed at height ${f.depositHeight}, before the V2 cutover (${f.minHeight}), and not on the reviewed pre-cutover list`;
    }
  }
  if (row.expected_deposit_address === null) return 'cannot derive the bridge address for this row (no hd_index?)';
  if (row.deposit_address !== row.expected_deposit_address) {
    return `recorded deposit address ${row.deposit_address} is not the bridge's address ${row.expected_deposit_address} at this hd_index`;
  }
  if (row.registered_recipient === null || row.registered_deposit_address === null) {
    return `no deposit_addresses row for this hd_index: no registered recipient to check ${row.recipient_address} against`;
  }
  if (row.registered_deposit_address !== row.deposit_address) {
    return `deposit_addresses row for this hd_index is ${row.registered_deposit_address}, not the recorded ${row.deposit_address}`;
  }
  if (!sameEvmAddress(row.recipient_address, row.registered_recipient)) {
    return `recipient ${row.recipient_address} is not the recipient registered for ${row.deposit_address} (${row.registered_recipient})`;
  }
  const out = st.outputs?.find((o) => o.n === row.vout);
  if (out === undefined) return `tx has no output ${row.vout}`;
  if (out.address !== row.deposit_address) {
    return `output ${row.vout} pays ${out.address}, not ${row.deposit_address}`;
  }
  if (row.deposit_value_sat === null || row.deposit_value_sat === undefined) {
    if (row.require_deposit_value) return 'no recorded deposit value for this row (needed to sign sourceValue)';
  } else if (BigInt(row.deposit_value_sat) !== out.valueSat) {
    return `recorded deposit value ${row.deposit_value_sat} != the node's output value ${out.valueSat}`;
  }
  const amount = BigInt(row.amount_sat);
  if (amount <= 0n) return `non-positive amount ${amount}`;
  if (out.valueSat < amount) {
    return `output ${row.vout} is ${out.valueSat} sat, less than ${amount} to mint`;
  }
  let expected: string;
  try {
    expected = computeDepositId({
      sourceChainName:        row.source_chain_name,
      dobbscoinTxid:          row.txid,
      vout:                   row.vout,
      depositAddress:         out.address,
      rawAmountSat:           out.valueSat,
      recipientGnosisAddress: row.recipient_address as Address,
    });
  } catch (err) {
    return `cannot recompute depositId: ${(err as Error).message}`;
  }
  if (expected.toLowerCase() !== row.deposit_id_hex.toLowerCase()) {
    return `depositId ${row.deposit_id_hex} does not match the node's output (expected ${expected})`;
  }
  return null;
}

/** Same 20-byte EVM address, ignoring checksum case. Anything malformed is never equal. */
function sameEvmAddress(a: string, b: string): boolean {
  const ok = (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x);
  return ok(a) && ok(b) && a.toLowerCase() === b.toLowerCase();
}
