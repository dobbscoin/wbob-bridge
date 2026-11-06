/**
 * Withdrawal destination sanitizer (2026-11-05).
 *
 * BridgeController.requestWithdrawal only checks that `dobbscoinAddress` is
 * non-empty, so the string in a WithdrawalRequested event is attacker-chosen.
 * Two values made _createWithdrawalOrder fail on EVERY retry, and because the
 * scanner halts at the first failing event (by design, for transient errors),
 * one cheap withdrawal stopped ingestion of all later withdrawals:
 *   - a NUL byte: Postgres TEXT rejects 0x00 (error 22021)
 *   - a very long string: idx_bridge_orders_dob_addr is a btree, and btree
 *     rejects index rows over ~2.7 kB
 *
 * A storable value (1-128 bytes of printable ASCII, no spaces) is returned
 * unchanged, so every legitimate withdrawal is stored exactly as before.
 * Anything else becomes `INVALID:<hex of the UTF-8 bytes, first 64 bytes>`:
 * safe to store and index, still traceable to the event, and certain to fail
 * the payout step's address decode, which parks the order in MANUAL_REVIEW
 * before any UTXO is reserved. The solvency monitor alerts on MANUAL_REVIEW
 * (MANUAL_REVIEW_ORDERS) until an operator resolves it.
 *
 * This only makes the value STORABLE. Whether it is PAYABLE (base58check,
 * P2PKH, right network) is still decided by the payout step, unchanged.
 */

const PLAUSIBLE = /^[\x21-\x7e]{1,128}$/;
const MAX_HEX_BYTES = 64;
const SENTINEL = 'INVALID:';

export interface SanitizedDestination {
  value: string;
  invalid: boolean;
  reason?: string;
}

export function sanitizeDobbscoinDestination(raw: unknown): SanitizedDestination {
  if (typeof raw !== 'string') {
    return { value: 'INVALID:not-a-string', invalid: true, reason: `not a string (${typeof raw})` };
  }
  if (PLAUSIBLE.test(raw) && !raw.startsWith(SENTINEL)) return { value: raw, invalid: false };

  const bytes = Buffer.from(raw, 'utf8');
  const reasons: string[] = [];
  if (bytes.length === 0) reasons.push('empty');
  if (raw.includes('\u0000')) reasons.push('contains a NUL byte');
  if (bytes.length > 128) reasons.push(`too long (${bytes.length} bytes)`);
  if (/[^\x21-\x7e\u0000]/.test(raw)) reasons.push('contains whitespace, control or non-ASCII characters');
  if (raw.startsWith(SENTINEL)) reasons.push('uses the reserved INVALID: prefix');

  const hex = bytes.subarray(0, MAX_HEX_BYTES).toString('hex');
  const more = bytes.length > MAX_HEX_BYTES ? `..(+${bytes.length - MAX_HEX_BYTES}B)` : '';
  return { value: `${SENTINEL}${hex}${more}`, invalid: true, reason: reasons.join('; ') };
}

/**
 * Payout-side guard: a destination the ingest step neutralized can never be
 * paid. Returns the reason to park it in MANUAL_REVIEW up front, before any
 * UTXO selection or RPC, so the recorded reason is explicit; null otherwise.
 */
export function unpayableDestinationReason(stored: string): string | null {
  return stored.startsWith(SENTINEL)
    ? `invalid withdrawal destination (sanitized at ingest; see the ORDER_CREATED audit row): ${stored.slice(0, 80)}`
    : null;
}
