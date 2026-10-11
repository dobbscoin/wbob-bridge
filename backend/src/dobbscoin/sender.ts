/**
 * Who sent a deposit — the address a refund goes back to.
 *
 * Policy (btcbob, 2026-10): the refund address is the address of the previous
 * output spent by the deposit transaction's FIRST input. When that cannot be
 * determined unambiguously the bridge does not guess: the caller parks the
 * refund in needs_attention and pages a human.
 *
 * Unambiguous means all of:
 *   - the deposit tx has at least one input and vin[0] is not a coinbase
 *   - the previous tx is retrievable (the node runs txindex=1)
 *   - the spent output is plain P2PKH (the only type the tx builder can pay)
 *   - our own decoding of its scriptPubKey agrees with the node's address
 *   - it is not one of the bridge's own addresses
 *
 * The decision is pure (resolveSender) so every refusal path is unit tested;
 * the RPC wrapper only fetches the two transactions.
 */

import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { RpcCallError, type DobbscoinBackendRpc, type RpcVerboseTx } from './rpc.js';

const b58check = base58check(sha256);

export type SenderResult =
  | { ok: true; address: string; detail: SenderDetail }
  | { ok: false; reason: string; detail: SenderDetail };

export interface SenderDetail {
  inputCount:      number;
  prevTxid:        string | null;
  prevVout:        number | null;
  scriptType:      string | null;
  /** Inputs past the first — refunds follow vin[0] regardless; recorded so ops can see it. */
  multiInput:      boolean;
}

const P2PKH_SCRIPT = /^76a914([0-9a-f]{40})88ac$/;

/** Base58Check P2PKH address for a 20-byte hash160 and version byte. */
export function hash160ToP2PKH(hash160Hex: string, versionByte: number): string {
  const hash = Buffer.from(hash160Hex, 'hex');
  if (hash.length !== 20) throw new Error(`hash160 must be 20 bytes, got ${hash.length}`);
  const payload = new Uint8Array(21);
  payload[0] = versionByte;
  payload.set(hash, 1);
  return b58check.encode(payload);
}

/**
 * Decide the refund address from the decoded deposit tx and the decoded tx
 * that created the output its first input spends (`prevTx`, null if the node
 * could not find it).
 */
export function resolveSender(
  depositTx: RpcVerboseTx,
  prevTx: RpcVerboseTx | null,
  versionByte: number,
  bridgeAddresses: ReadonlySet<string> = new Set(),
): SenderResult {
  const first = depositTx.vin[0];
  const detail: SenderDetail = {
    inputCount: depositTx.vin.length,
    prevTxid:   first?.txid ?? null,
    prevVout:   first?.vout ?? null,
    scriptType: null,
    multiInput: depositTx.vin.length > 1,
  };
  const no = (reason: string): SenderResult => ({ ok: false, reason, detail });

  if (!first) return no('deposit transaction has no inputs');
  if (first.coinbase !== undefined) return no('deposit came straight from a coinbase (mined) input — no sender address');
  if (!first.txid || first.vout === undefined) return no('first input has no previous outpoint');
  if (!prevTx) return no(`previous transaction ${first.txid} not found on the node`);
  if (prevTx.txid && prevTx.txid !== first.txid) return no('node returned a different previous transaction than requested');

  const out = prevTx.vout.find((o) => o.n === first.vout);
  if (!out) return no(`previous transaction has no output ${first.vout}`);
  detail.scriptType = out.scriptPubKey.type;

  if (out.scriptPubKey.type !== 'pubkeyhash') {
    return no(`sender output is ${out.scriptPubKey.type}, not P2PKH — refunds can only pay P2PKH`);
  }
  const m = P2PKH_SCRIPT.exec(out.scriptPubKey.hex.toLowerCase());
  if (!m) return no('sender output is labelled P2PKH but its script is not the standard P2PKH template');

  const decoded = hash160ToP2PKH(m[1]!, versionByte);
  const nodeAddrs = out.scriptPubKey.addresses ?? (out.scriptPubKey.address ? [out.scriptPubKey.address] : []);
  if (nodeAddrs.length !== 1) return no(`node reports ${nodeAddrs.length} addresses for the sender output`);
  if (nodeAddrs[0] !== decoded) {
    return no(`node address ${nodeAddrs[0]} disagrees with decoded script address ${decoded}`);
  }
  if (bridgeAddresses.has(decoded)) {
    return no(`sender ${decoded} is one of the bridge's own addresses`);
  }
  return { ok: true, address: decoded, detail };
}

/** Fetch the deposit tx and its first input's previous tx, then resolveSender. */
export async function detectDepositSender(
  rpc: Pick<DobbscoinBackendRpc, 'getRawTransactionVerbose'>,
  depositTxid: string,
  versionByte: number,
  bridgeAddresses: ReadonlySet<string> = new Set(),
): Promise<SenderResult> {
  const depositTx = await rpc.getRawTransactionVerbose(depositTxid);
  const first = depositTx.vin[0];
  let prevTx: RpcVerboseTx | null = null;
  if (first && first.coinbase === undefined && first.txid) {
    try {
      prevTx = await rpc.getRawTransactionVerbose(first.txid);
    } catch (err) {
      // -5 = "No such mempool or blockchain transaction": a definite answer.
      // Anything else (network, timeout) is transient and must be retried,
      // not turned into a needs-attention verdict.
      if (!(err instanceof RpcCallError && err.code === -5)) throw err;
    }
  }
  return resolveSender(depositTx, prevTx, versionByte, bridgeAddresses);
}
