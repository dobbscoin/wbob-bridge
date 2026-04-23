/**
 * Dobbscoin transaction builder.
 *
 * Constructs, signs, and serialises a P2PKH payout transaction from
 * bridge-controlled UTXOs to a user's Dobbscoin address.
 *
 * UTXO selection: largest-first greedy — simple and effective for low-volume.
 * Fee estimate: 148 vbytes/input + 34 vbytes/output + 10 vbytes overhead (P2PKH).
 */

import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { pubkeyToP2PKH } from '../wallet/hd-wallet.js';
import type { DobbscoinBackendRpc } from './rpc.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UtxoInput {
  txid:     string;   // big-endian hex (RPC display format)
  vout:     number;
  amountSat: bigint;
  hdIndex:  number;   // which HD index produced this address
}

export interface BuildTxResult {
  /** Raw signed transaction hex (ready for sendrawtransaction). */
  rawHex: string;
  /** Txid of the signed transaction (big-endian hex). */
  txid: string;
  /** Total input amount (satoshis). */
  inputAmountSat: bigint;
  /** Fee paid (satoshis). */
  feeSat: bigint;
  /** Change amount sent back to bridge (satoshis, 0 if no change output). */
  changeSat: bigint;
  /** UTXOs consumed by this transaction. */
  inputs: UtxoInput[];
}

// ─── Fee estimation ───────────────────────────────────────────────────────────

const BYTES_PER_INPUT  = 148;
const BYTES_PER_OUTPUT = 34;
const TX_OVERHEAD      = 10;

export function estimateFee(
  inputCount: number,
  outputCount: number,
  feeRateSatPerVbyte: number,
): bigint {
  const vbytes = TX_OVERHEAD + inputCount * BYTES_PER_INPUT + outputCount * BYTES_PER_OUTPUT;
  return BigInt(vbytes * feeRateSatPerVbyte);
}

// ─── UTXO selection ───────────────────────────────────────────────────────────

/**
 * Largest-first greedy UTXO selection.
 * Returns the minimal set of UTXOs whose total >= targetSat + estimatedFee.
 * Throws if the available set is insufficient.
 */
export function selectUtxos(
  available: UtxoInput[],
  targetSat: bigint,
  feeRateSatPerVbyte: number,
): { selected: UtxoInput[]; feeSat: bigint } {
  const sorted = [...available].sort((a, b) =>
    a.amountSat > b.amountSat ? -1 : a.amountSat < b.amountSat ? 1 : 0,
  );

  const selected: UtxoInput[] = [];
  let total = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.amountSat;
    // +1 output for change if we have excess
    const outputCount = total > targetSat ? 2 : 1;
    const fee = estimateFee(selected.length, outputCount, feeRateSatPerVbyte);
    if (total >= targetSat + fee) {
      return { selected, feeSat: fee };
    }
  }

  throw new Error(
    `Insufficient UTXOs: need ${targetSat} sat, have ${total} sat across ${available.length} UTXOs`,
  );
}

// ─── TxBuilder ────────────────────────────────────────────────────────────────

export class DobbscoinTxBuilder {
  private readonly rootKey: HDKey;
  private readonly versionByte: number;

  constructor(
    xpriv: string,
    versionByte = 0x00,
  ) {
    this.rootKey = HDKey.fromExtendedKey(xpriv);
    this.versionByte = versionByte;
  }

  /**
   * Build, sign and serialise a payout transaction.
   *
   * @param utxos             Available bridge UTXOs (all must be available status).
   * @param payoutAmountSat   Amount to send to recipient (after deducting fee).
   * @param recipientAddress  User's Dobbscoin address.
   * @param changeAddress     Bridge change address (receives leftover).
   * @param feeRateSatPerVbyte
   * @param rpc               RPC client to fetch previous tx bytes for inputs.
   */
  async buildPayoutTx(
    utxos: UtxoInput[],
    payoutAmountSat: bigint,
    recipientAddress: string,
    changeAddress: string,
    feeRateSatPerVbyte: number,
    rpc: DobbscoinBackendRpc,
  ): Promise<BuildTxResult> {
    const { selected, feeSat } = selectUtxos(utxos, payoutAmountSat, feeRateSatPerVbyte);
    const inputTotal = selected.reduce((s, u) => s + u.amountSat, 0n);
    const changeSat = inputTotal - payoutAmountSat - feeSat;

    const tx = new btc.Transaction();

    // ── Add inputs ────────────────────────────────────────────────────────────
    for (const utxo of selected) {
      const prevHex = await rpc.getRawTransactionHex(utxo.txid);
      const prevBytes = Buffer.from(prevHex, 'hex');

      // txid must be little-endian for @scure/btc-signer
      const txidLE = Buffer.from(utxo.txid, 'hex').reverse();

      tx.addInput({
        txid: txidLE,
        index: utxo.vout,
        nonWitnessUtxo: prevBytes,
      });
    }

    // ── Add outputs ───────────────────────────────────────────────────────────
    tx.addOutput({
      script: addressToScript(recipientAddress, this.versionByte),
      amount: payoutAmountSat,
    });

    if (changeSat > 546n) { // dust threshold
      tx.addOutput({
        script: addressToScript(changeAddress, this.versionByte),
        amount: changeSat,
      });
    }

    // ── Sign each input with the derived private key ───────────────────────
    for (let i = 0; i < selected.length; i++) {
      const utxo = selected[i]!;
      const privKey = this.derivePrivKey(utxo.hdIndex);
      tx.sign(privKey, undefined, new Uint8Array([i]));
    }

    tx.finalize();
    const rawBytes = tx.extract();
    const rawHex = Buffer.from(rawBytes).toString('hex');

    // Compute txid: dsha256 of raw bytes, reversed (big-endian display format)
    const hash1 = sha256(rawBytes);
    const hash2 = sha256(hash1);
    const txidBytes = Buffer.from(hash2).reverse();
    const txid = txidBytes.toString('hex');

    return {
      rawHex,
      txid,
      inputAmountSat: inputTotal,
      feeSat: changeSat <= 546n ? inputTotal - payoutAmountSat : feeSat,
      changeSat: changeSat > 546n ? changeSat : 0n,
      inputs: selected,
    };
  }

  /** Derive the private key for a given HD index. */
  derivePrivKey(index: number): Uint8Array {
    const child = this.rootKey.derive(`m/0/${index}`);
    if (!child.privateKey) throw new Error(`No private key at index ${index}`);
    return child.privateKey;
  }

  /** Derive the change address at a given change index. */
  deriveChangeAddress(changeIndex: number): string {
    const child = this.rootKey.derive(`m/1/${changeIndex}`);
    if (!child.publicKey) throw new Error(`No public key for change at index ${changeIndex}`);
    return pubkeyToP2PKH(child.publicKey, this.versionByte);
  }
}

// ─── Address → scriptPubKey ───────────────────────────────────────────────────

/**
 * Convert a P2PKH base58check address to its scriptPubKey bytes.
 * scriptPubKey = OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
 */
function addressToScript(address: string, _versionByte: number): Uint8Array {
  // Use @scure/btc-signer's address decoder, then re-encode as scriptPubKey.
  // btc.p2pkh() takes a 33-byte public key; for a decoded address we have the
  // 20-byte hash160, so we must use OutScript.encode instead.
  const decoded = btc.Address().decode(address);
  if (decoded.type !== 'pkh') {
    throw new Error(`Unsupported address type: ${decoded.type} for ${address}`);
  }
  return btc.OutScript.encode({ type: 'pkh', hash: decoded.hash });
}
