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
    recipient_address: RECIPIENT, amount_sat: 100_000_000n, deposit_id_hex: id(RECIPIENT), ...over,
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
    expect(checkMintAgainstNode(row({ recipient_address: OTHER }), node(), FINAL)).toMatch(/does not match/);
  });

  it('refuses a depositId computed for a bigger output than the node shows', () => {
    expect(checkMintAgainstNode(row({ deposit_id_hex: id(RECIPIENT, 900_000_000n), amount_sat: 50_000_000n }), node(), FINAL))
      .toMatch(/does not match/);
  });
});
