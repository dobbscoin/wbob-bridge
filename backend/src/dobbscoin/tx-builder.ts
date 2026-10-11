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
  /** Which HD path the address was derived from. Deposits → m/0/N, change → m/1/N. */
  isChange: boolean;
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

/** Result of buildRefundTx. feeSat is the whole tx fee (refund share + bridgeFeeSat). */
export interface BuildRefundResult extends BuildTxResult {
  /** What reaches the refund address. */
  recipientSat: bigint;
  /** Fee paid by the bridge on top of the refunded excess (dust change folded into the fee). */
  bridgeFeeSat: bigint;
}

interface TxOutputSpec {
  address:   string;
  amountSat: bigint;
}

// ─── Fee estimation ───────────────────────────────────────────────────────────

const BYTES_PER_INPUT  = 148;
const BYTES_PER_OUTPUT = 34;
const TX_OVERHEAD      = 10;

/** Outputs at or below this many satoshis are dust: never created, folded into the fee. */
export const DUST_THRESHOLD_SAT = 546n;

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

// ─── Refund planning (pure) ──────────────────────────────────────────────────

export class RefundTooSmallError extends Error {
  constructor(public readonly grossSat: bigint, public readonly feeSat: bigint) {
    super(
      `Refund of ${grossSat} sat is too small: after the ${feeSat} sat network fee ` +
      `the output would be at or under dust (${DUST_THRESHOLD_SAT} sat)`,
    );
    this.name = 'RefundTooSmallError';
  }
}

/**
 * Smallest refund worth building: the fee of a 1-input, 2-output tx plus more
 * than dust left for the recipient. At or below this the excess is recorded as
 * too small and stays in the pool.
 */
export function isRefundTooSmall(grossSat: bigint, feeRateSatPerVbyte: number): boolean {
  return grossSat - estimateFee(1, 2, feeRateSatPerVbyte) <= DUST_THRESHOLD_SAT;
}

export interface RefundPlan {
  selected:     UtxoInput[];
  inputSat:     bigint;
  recipientSat: bigint;
  changeSat:    bigint;   // 0 when the remainder is dust (then folded into the fee)
  feeSat:       bigint;   // whole tx fee
  bridgeFeeSat: bigint;   // part of feeSat not covered by grossSat
}

/**
 * Choose inputs for a refund of `grossSat` whose fee is deducted from the
 * refund. Spends `preferred` first if present, then largest-first.
 */
export function planRefund(
  available: UtxoInput[],
  grossSat: bigint,
  feeRateSatPerVbyte: number,
  preferred: { txid: string; vout: number } | null = null,
): RefundPlan {
  if (grossSat <= 0n) throw new Error(`planRefund: gross must be positive, got ${grossSat}`);
  const isPreferred = (u: UtxoInput) =>
    preferred !== null && u.txid === preferred.txid && u.vout === preferred.vout;
  const ordered = [
    ...available.filter(isPreferred),
    ...available
      .filter((u) => !isPreferred(u))
      .sort((a, b) => (a.amountSat > b.amountSat ? -1 : a.amountSat < b.amountSat ? 1 : 0)),
  ];

  const selected: UtxoInput[] = [];
  let inputSat = 0n;
  for (const u of ordered) {
    selected.push(u);
    inputSat += u.amountSat;
    if (inputSat >= grossSat) break;
  }
  if (inputSat < grossSat) {
    throw new Error(
      `Insufficient UTXOs: need ${grossSat} sat, have ${inputSat} sat across ${available.length} UTXOs`,
    );
  }

  const rawChange = inputSat - grossSat;
  const hasChange = rawChange > DUST_THRESHOLD_SAT;
  const estFee = estimateFee(selected.length, hasChange ? 2 : 1, feeRateSatPerVbyte);
  const recipientSat = grossSat - estFee;
  if (recipientSat <= DUST_THRESHOLD_SAT) throw new RefundTooSmallError(grossSat, estFee);

  const changeSat = hasChange ? rawChange : 0n;
  const feeSat = inputSat - recipientSat - changeSat;
  return {
    selected,
    inputSat,
    recipientSat,
    changeSat,
    feeSat,
    bridgeFeeSat: feeSat - estFee,   // == the dust remainder when no change output
  };
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

    const outputs: TxOutputSpec[] = [{ address: recipientAddress, amountSat: payoutAmountSat }];
    if (changeSat > DUST_THRESHOLD_SAT) outputs.push({ address: changeAddress, amountSat: changeSat });
    const { rawHex, txid } = await this._signAndSerialize(selected, outputs, rpc);

    return {
      rawHex,
      txid,
      inputAmountSat: inputTotal,
      feeSat: changeSat <= DUST_THRESHOLD_SAT ? inputTotal - payoutAmountSat : feeSat,
      changeSat: changeSat > DUST_THRESHOLD_SAT ? changeSat : 0n,
      inputs: selected,
    };
  }

  /**
   * Build, sign and serialise a REFUND of `grossSat` whose network fee comes
   * out of the refund itself (unlike a withdrawal payout, where the bridge
   * subsidises the fee).
   *
   *   recipient gets  grossSat − estimatedFee
   *   pool loses      grossSat (+ any change remainder at or under dust, which
   *                   is folded into the fee and reported as bridgeFeeSat)
   *
   * `preferred` (normally the deposit UTXO being refunded) is spent first when
   * it is in `utxos`, so the usual refund is one input → refund + change of
   * exactly the minted part, and the pool keeps the minted coins untouched.
   *
   * Throws RefundTooSmallError when what would reach the recipient is dust.
   */
  async buildRefundTx(
    utxos: UtxoInput[],
    grossSat: bigint,
    recipientAddress: string,
    changeAddress: string,
    feeRateSatPerVbyte: number,
    rpc: DobbscoinBackendRpc,
    preferred: { txid: string; vout: number } | null = null,
  ): Promise<BuildRefundResult> {
    const plan = planRefund(utxos, grossSat, feeRateSatPerVbyte, preferred);

    const outputs: TxOutputSpec[] = [{ address: recipientAddress, amountSat: plan.recipientSat }];
    if (plan.changeSat > 0n) outputs.push({ address: changeAddress, amountSat: plan.changeSat });
    const { rawHex, txid } = await this._signAndSerialize(plan.selected, outputs, rpc);

    return {
      rawHex,
      txid,
      inputAmountSat: plan.inputSat,
      feeSat: plan.feeSat,
      changeSat: plan.changeSat,
      inputs: plan.selected,
      recipientSat: plan.recipientSat,
      bridgeFeeSat: plan.bridgeFeeSat,
    };
  }

  /** Shared by payouts and refunds: add inputs and outputs, sign every input, serialise. */
  private async _signAndSerialize(
    selected: UtxoInput[],
    outputs: TxOutputSpec[],
    rpc: DobbscoinBackendRpc,
  ): Promise<{ rawHex: string; txid: string }> {
    // Dobbscoin is a pre-0.12 Bitcoin Core fork. Its consensus rules predate
    // BIP68 (Bitcoin Core 0.11 introduced tx version 2), so it rejects v2 txs
    // with `sendrawtransaction error -26: 64: version`. Default @scure/btc-signer
    // emits v2; force v1 for broadcast acceptance.
    const tx = new btc.Transaction({ version: 1 });

    // ── Add inputs ────────────────────────────────────────────────────────────
    for (const utxo of selected) {
      const prevHex = await rpc.getRawTransactionHex(utxo.txid);
      const prevBytes = Buffer.from(prevHex, 'hex');

      // @scure/btc-signer accepts the txid in DISPLAY byte order (same as RPC
      // returns) and reverses internally when serializing. Do NOT pre-reverse
      // here — the raw tx's prev_hash field needs to be the REVERSE of the
      // display txid, and btc-signer does that step for us. Empirically
      // verified: pre-reversing produces a raw tx referencing a non-existent
      // txid, causing `sendrawtransaction error -25`.
      tx.addInput({
        txid: Buffer.from(utxo.txid, 'hex'),
        index: utxo.vout,
        nonWitnessUtxo: prevBytes,
      });
    }

    // ── Add outputs ───────────────────────────────────────────────────────────
    // Order is load-bearing: recipient at vout 0, change (if any) at vout 1 —
    // the executors ingest change as <txid>:1.
    for (const out of outputs) {
      tx.addOutput({
        script: addressToScript(out.address, this.versionByte),
        amount: out.amountSat,
      });
    }

    // ── Sign each input with the derived private key ───────────────────────
    for (let i = 0; i < selected.length; i++) {
      const utxo = selected[i]!;
      const privKey = this.derivePrivKey(utxo.hdIndex, utxo.isChange);
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

    return { rawHex, txid };
  }

  /** Derive the private key for a given HD index. */
  derivePrivKey(index: number, isChange = false): Uint8Array {
    const path = isChange ? `m/1/${index}` : `m/0/${index}`;
    const child = this.rootKey.derive(path);
    if (!child.privateKey) throw new Error(`No private key at ${path}`);
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
