/**
 * Refund transactions: fee deducted from the refund, deposit UTXO spent first,
 * minted part returned to the bridge as change, dust never created.
 */

import { describe, it, expect } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import {
  DUST_THRESHOLD_SAT,
  DobbscoinTxBuilder,
  RefundTooSmallError,
  estimateFee,
  isRefundTooSmall,
  planRefund,
  type UtxoInput,
} from '../../src/dobbscoin/tx-builder.js';
import { pubkeyToP2PKH } from '../../src/wallet/hd-wallet.js';

const ROOT = HDKey.fromMasterSeed(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
const XPRIV = ROOT.privateExtendedKey!;
const RATE = 10;

/** One-output prev tx paying `amountSat` to the hash160 of `pubkey` (vout 0). */
function prevTxHex(pubkey: Uint8Array, amountSat: bigint): string {
  const h = ripemd160(sha256(pubkey));
  const script = Buffer.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
  const amt = Buffer.alloc(8); amt.writeBigInt64LE(amountSat, 0);
  const ver = Buffer.alloc(4); ver.writeUInt32LE(1, 0);
  return Buffer.concat([
    ver, Buffer.from([1]), Buffer.alloc(32, 0), Buffer.alloc(4, 0), Buffer.from([0]), Buffer.alloc(4, 0xff),
    Buffer.from([1]), amt, Buffer.from([script.length]), script, Buffer.alloc(4),
  ]).toString('hex');
}

const u = (txid: string, amountSat: bigint, vout = 0, hdIndex = 0): UtxoInput =>
  ({ txid, vout, amountSat, hdIndex, isChange: false });

describe('isRefundTooSmall', () => {
  const minFee = estimateFee(1, 2, RATE); // 2260 sat at 10 sat/vB

  it('1 sat excess (1,000,000.00000001 deposit) is too small', () => {
    expect(isRefundTooSmall(1n, RATE)).toBe(true);
  });

  it('fee + dust exactly is too small; one more sat is not', () => {
    expect(isRefundTooSmall(minFee + DUST_THRESHOLD_SAT, RATE)).toBe(true);
    expect(isRefundTooSmall(minFee + DUST_THRESHOLD_SAT + 1n, RATE)).toBe(false);
  });
});

describe('planRefund', () => {
  const DEPOSIT = u('d'.repeat(64), 5_000_000_000n, 2);  // 50 BOB deposit
  const BIG     = u('b'.repeat(64), 90_000_000_000n);     // a larger pool UTXO

  it('spends the deposit UTXO first even when a larger one exists', () => {
    const p = planRefund([BIG, DEPOSIT], 1_000_000_000n, RATE, { txid: DEPOSIT.txid, vout: 2 });
    expect(p.selected).toEqual([DEPOSIT]);
  });

  it('fee comes out of the refund: recipient = excess − fee, change = the minted part', () => {
    const excess = 1_000_000_000n; // 10 BOB over the cap, 40 BOB minted
    const p = planRefund([DEPOSIT], excess, RATE, { txid: DEPOSIT.txid, vout: 2 });
    const fee = estimateFee(1, 2, RATE);
    expect(p.recipientSat).toBe(excess - fee);
    expect(p.changeSat).toBe(DEPOSIT.amountSat - excess);
    expect(p.feeSat).toBe(fee);
    expect(p.bridgeFeeSat).toBe(0n);
    // pool loses exactly the excess
    expect(p.inputSat - p.changeSat).toBe(excess);
  });

  it('whole-deposit refund (mint 0): single output, no change', () => {
    const p = planRefund([DEPOSIT], DEPOSIT.amountSat, RATE, { txid: DEPOSIT.txid, vout: 2 });
    expect(p.changeSat).toBe(0n);
    expect(p.feeSat).toBe(estimateFee(1, 1, RATE));
    expect(p.recipientSat).toBe(DEPOSIT.amountSat - estimateFee(1, 1, RATE));
    expect(p.bridgeFeeSat).toBe(0n);
  });

  it('change at or under dust is folded into the fee and reported as bridge fee', () => {
    const dep = u('d'.repeat(64), 1_000_000n + 500n, 0);
    const p = planRefund([dep], 1_000_000n, RATE, { txid: dep.txid, vout: 0 });
    expect(p.changeSat).toBe(0n);
    expect(p.bridgeFeeSat).toBe(500n);
    expect(p.recipientSat).toBe(1_000_000n - estimateFee(1, 1, RATE));
    expect(p.feeSat).toBe(estimateFee(1, 1, RATE) + 500n);
  });

  it('falls back to largest-first when the deposit UTXO is gone (already spent by a payout)', () => {
    const p = planRefund([u('a'.repeat(64), 10n), BIG], 1_000_000_000n, RATE, { txid: DEPOSIT.txid, vout: 2 });
    expect(p.selected).toEqual([BIG]);
  });

  it('throws RefundTooSmallError when the recipient would get dust', () => {
    expect(() => planRefund([DEPOSIT], 2_000n, RATE, null)).toThrow(RefundTooSmallError);
  });

  it('throws Insufficient UTXOs when the pool cannot cover it', () => {
    expect(() => planRefund([u('a'.repeat(64), 10_000n)], 1_000_000n, RATE, null)).toThrow(/^Insufficient UTXOs/);
  });
});

describe('DobbscoinTxBuilder.buildRefundTx (signed, end to end)', () => {
  it('pays sender at vout 0, change to the bridge at vout 1, inputs signed', async () => {
    const depositKey = ROOT.derive('m/0/0');
    const depositAmount = 5_000_000_000n;
    const prevHex = prevTxHex(depositKey.publicKey!, depositAmount);
    const prevTxid = Buffer.from(sha256(sha256(Buffer.from(prevHex, 'hex')))).reverse().toString('hex');
    const rpc = { getRawTransactionHex: async () => prevHex } as never;

    const builder = new DobbscoinTxBuilder(XPRIV, 0x00);
    const changeAddr = builder.deriveChangeAddress(0);
    const sender = pubkeyToP2PKH(ROOT.derive('m/7/7').publicKey!, 0x00);
    const excess = 1_000_000_000n;

    const r = await builder.buildRefundTx(
      [u(prevTxid, depositAmount, 0, 0)], excess, sender, changeAddr, RATE, rpc, { txid: prevTxid, vout: 0 },
    );

    const tx = btc.Transaction.fromRaw(Buffer.from(r.rawHex, 'hex'));
    expect(tx.version).toBe(1);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    const out0 = tx.getOutput(0);
    const out1 = tx.getOutput(1);
    expect(out0.amount).toBe(excess - estimateFee(1, 2, RATE));
    expect(btc.Address().encode(btc.OutScript.decode(out0.script!))).toBe(sender);
    expect(out1.amount).toBe(depositAmount - excess);
    expect(btc.Address().encode(btc.OutScript.decode(out1.script!))).toBe(changeAddr);
    expect(r.recipientSat).toBe(out0.amount);
    expect(r.changeSat).toBe(out1.amount);
    expect(r.feeSat).toBe(depositAmount - out0.amount! - out1.amount!);
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});
