import { describe, it, expect } from 'vitest';
import { checkMintAgainstNode, type MintCheckRow } from '../../src/signing/node-check.js';
import { computeDepositId } from '../../src/deposits/deposit-id.js';
import type { Address } from '@wbob/shared';

const TXID = 'a5214195c5e5481759fd3b553ca1318543685cf6f45c5e2b8f2d466ff4cc8c37';
const ADDR = '115uVZexampleDepositAddrxxxxxxxxx';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const OTHER = '0x1111111111111111111111111111111111111111';
const FINAL = 60;

function id(recipient: string, valueSat = 100_000_000n, address = ADDR, vout = 0) {
  return computeDepositId({
    sourceChainName: 'dobbscoin-mainnet', dobbscoinTxid: TXID, vout,
    depositAddress: address, rawAmountSat: valueSat, recipientGnosisAddress: recipient as Address,
  });
}

function row(over: Partial<MintCheckRow> = {}): MintCheckRow {
  return {
    txid: TXID, vout: 0, deposit_address: ADDR, source_chain_name: 'dobbscoin-mainnet',
    recipient_address: RECIPIENT, amount_sat: 100_000_000n, deposit_id_hex: id(RECIPIENT),
    expected_deposit_address: ADDR, registered_recipient: RECIPIENT, registered_deposit_address: ADDR, ...over,
  };
}

const node = (over: Partial<{ confirmations: number; address: string; valueSat: bigint; n: number }> = {}) => ({
  confirmations: over.confirmations ?? 5741,
  blockHash: 'abc',
  outputs: [{ n: over.n ?? 0, address: over.address ?? ADDR, valueSat: over.valueSat ?? 100_000_000n }],
});

describe('checkMintAgainstNode', () => {
  it('signs a deposit the node shows deep, paying the address, with a matching depositId', () => {
    expect(checkMintAgainstNode(row(), node(), FINAL)).toBeNull();
  });

  it('signs a daily-cap partial mint (amount < output value; depositId uses the full output)', () => {
    expect(checkMintAgainstNode(row({ amount_sat: 40_000_000n }), node(), FINAL)).toBeNull();
  });

  it('is case-insensitive on the recipient and depositId hex', () => {
    expect(checkMintAgainstNode(
      row({ recipient_address: RECIPIENT.toLowerCase(), deposit_id_hex: id(RECIPIENT).toUpperCase().replace('0X', '0x') }),
      node(), FINAL)).toBeNull();
  });

  it('refuses when the node does not know the tx (-5)', () => {
    expect(checkMintAgainstNode(row(), null, FINAL)).toMatch(/does not know/);
  });

  it('refuses below final depth, including 0 (orphaned block)', () => {
    expect(checkMintAgainstNode(row(), node({ confirmations: 59 }), FINAL)).toMatch(/59 confirmations/);
    expect(checkMintAgainstNode(row(), node({ confirmations: 0 }), FINAL)).toMatch(/0 confirmations/);
  });

  it('refuses when the output index does not exist', () => {
    expect(checkMintAgainstNode(row({ vout: 3 }), node(), FINAL)).toMatch(/no output 3/);
  });

  it('refuses when the output pays a different address', () => {
    expect(checkMintAgainstNode(row(), node({ address: '1Attacker' }), FINAL)).toMatch(/pays 1Attacker/);
  });

  it('refuses to authorize more than the output is worth', () => {
    expect(checkMintAgainstNode(row({ amount_sat: 100_000_001n }), node(), FINAL)).toMatch(/less than/);
  });

  it('refuses a zero amount', () => {
    expect(checkMintAgainstNode(row({ amount_sat: 0n }), node(), FINAL)).toMatch(/non-positive/);
  });

  it('refuses a recipient swapped without updating the depositId', () => {
    // (registered recipient also OTHER, so this exercises the depositId check, not the registry one)
    expect(checkMintAgainstNode(row({ recipient_address: OTHER, registered_recipient: OTHER }), node(), FINAL)).toMatch(/does not match/);
  });

  it('refuses a depositId computed for a bigger output than the node shows', () => {
    expect(checkMintAgainstNode(row({ deposit_id_hex: id(RECIPIENT, 900_000_000n), amount_sat: 50_000_000n }), node(), FINAL))
      .toMatch(/does not match/);
  });

  it('refuses a row whose deposit address is NOT the bridge address at its hd_index (DB-forged row)', () => {
    // Attacker pays their own address and writes a row pointing at it: output and row agree, the xpub does not.
    const r = row({ deposit_address: '1AttackerOwnAddressxxxxxxxxxxxxx', expected_deposit_address: ADDR,
                    deposit_id_hex: id(RECIPIENT, 100_000_000n, '1AttackerOwnAddressxxxxxxxxxxxxx') });
    expect(checkMintAgainstNode(r, node({ address: '1AttackerOwnAddressxxxxxxxxxxxxx' }), FINAL)).toMatch(/is not the bridge's address/);
  });

  it('refuses when the bridge address cannot be derived (no hd_index)', () => {
    expect(checkMintAgainstNode(row({ expected_deposit_address: null }), node(), FINAL)).toMatch(/cannot derive/);
  });

  it('refuses when the recorded deposit value differs from the node (it is signed as sourceValue in V2)', () => {
    expect(checkMintAgainstNode(row({ deposit_value_sat: 100_000_001n }), node(), FINAL)).toMatch(/recorded deposit value/);
    expect(checkMintAgainstNode(row({ deposit_value_sat: 100_000_000n }), node(), FINAL)).toBeNull();
  });

  it('V2 requires a recorded deposit value; V1 tolerates a legacy row without one', () => {
    expect(checkMintAgainstNode(row({ deposit_value_sat: null, require_deposit_value: true }), node(), FINAL)).toMatch(/no recorded deposit value/);
    expect(checkMintAgainstNode(row({ deposit_value_sat: null }), node(), FINAL)).toBeNull();
  });

  // ── review round 6 #2: the V2 cutover floor ──
  const floor = (depositHeight: number | null, allowed: string[] = []) =>
    ({ minHeight: 1_950_000, allowed: new Set(allowed), depositHeight });
  it('V2 floor: a deposit confirmed at or after the cutover height signs', () => {
    expect(checkMintAgainstNode(row({ cutover_floor: floor(1_950_000) }), node(), FINAL)).toBeNull();
    expect(checkMintAgainstNode(row({ cutover_floor: floor(1_960_123) }), node(), FINAL)).toBeNull();
  });
  it('V2 floor: an older deposit is refused unless it is on the reviewed list', () => {
    expect(checkMintAgainstNode(row({ cutover_floor: floor(1_949_999) }), node(), FINAL)).toMatch(/before the V2 cutover/);
    expect(checkMintAgainstNode(row({ cutover_floor: floor(1_900_000, [`${TXID}:0`]) }), node(), FINAL)).toBeNull();
    expect(checkMintAgainstNode(row({ cutover_floor: floor(1_900_000, [`${TXID}:1`]) }), node(), FINAL)).toMatch(/before the V2 cutover/);
  });
  it('V2 floor: an unknown deposit height is a refusal, never a pass', () => {
    expect(checkMintAgainstNode(row({ cutover_floor: floor(null) }), node(), FINAL)).toMatch(/block height/);
  });

  // ── 2026-11-12 watcher split: recipient must be the address's registered one ──
  it('refuses a real deposit re-paired with another recipient and a freshly computed depositId', () => {
    // A DB writer records the real output, its own recipient, and the depositId that matches them.
    expect(checkMintAgainstNode(row({ recipient_address: OTHER, deposit_id_hex: id(OTHER) }), node(), FINAL))
      .toMatch(/not the recipient registered/);
  });
  it('signs when the registered recipient differs only in checksum case', () => {
    expect(checkMintAgainstNode(row({ registered_recipient: RECIPIENT.toLowerCase() }), node(), FINAL)).toBeNull();
    expect(checkMintAgainstNode(row({ registered_recipient: RECIPIENT.toUpperCase().replace('0X', '0x') }), node(), FINAL)).toBeNull();
  });
  it('refuses when there is no deposit_addresses row for the hd_index', () => {
    expect(checkMintAgainstNode(row({ registered_recipient: null, registered_deposit_address: null }), node(), FINAL))
      .toMatch(/no deposit_addresses row/);
  });
  it('refuses when the deposit_addresses row is for a different address', () => {
    expect(checkMintAgainstNode(row({ registered_deposit_address: '1SomeOtherAddrxxxxxxxxxxxxxxxxxx' }), node(), FINAL))
      .toMatch(/deposit_addresses row for this hd_index is/);
  });
  it('a malformed registered recipient never matches', () => {
    expect(checkMintAgainstNode(row({ registered_recipient: 'dead' }), node(), FINAL)).toMatch(/not the recipient registered/);
  });
});
