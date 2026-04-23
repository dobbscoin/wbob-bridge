/**
 * Bitcoin Core JSON-RPC type definitions.
 * Field names match the raw RPC responses exactly.
 */

// ─── Raw RPC response envelope ───────────────────────────────────────────────

export interface RpcResponse<T> {
  result: T;
  error: RpcError | null;
  id: string | number | null;
}

export interface RpcError {
  code: number;
  message: string;
}

// ─── Block ───────────────────────────────────────────────────────────────────

export interface RpcVin {
  txid?: string;        // absent for coinbase
  vout?: number;
  coinbase?: string;
  sequence: number;
}

export interface RpcVout {
  value: number;        // BTC (float) — we parse to satoshis
  n: number;
  scriptPubKey: RpcScriptPubKey;
}

export interface RpcScriptPubKey {
  asm: string;
  hex: string;
  type: string;
  address?: string;     // present for standard output types
  addresses?: string[]; // legacy field (pre-descriptor wallet), may be present in some versions
}

export interface RpcRawTransaction {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: RpcVin[];
  vout: RpcVout[];
  hex: string;
  blockhash?: string;   // absent for mempool txs
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

export interface RpcBlock {
  hash: string;
  confirmations: number;
  height: number;
  previousblockhash?: string;   // absent for genesis
  /**
   * Decoded transactions. Dobbscoin RPC only returns txids from `getblock`,
   * so the client fetches each tx via `getrawtransaction` and assembles this.
   */
  tx: RpcRawTransaction[];
}

export interface RpcBlockchainInfo {
  chain: string;
  blocks: number;         // height of the chain tip
  headers: number;
  bestblockhash: string;
  difficulty: number;
  time: number;
  mediantime: number;
  verificationprogress: number;
  chainwork: string;
  pruned: boolean;
  softforks: Record<string, unknown>;
}

export interface RpcMempoolEntry {
  vsize: number;
  weight: number;
  fee: number;
  modifiedfee: number;
  time: number;
  height: number;
  descendantcount: number;
  descendantsize: number;
  descendantfees: number;
  ancestorcount: number;
  ancestorsize: number;
  ancestorfees: number;
  depends: string[];
  spentby: string[];
  wtxid: string;
}

export type RpcMempoolMap = Record<string, RpcMempoolEntry>;

// ─── Parsed / domain types ────────────────────────────────────────────────────

/** A block + txid list at a given height, used by the reorg detector. */
export interface BlockHeader {
  hash: string;
  height: number;
  previousblockhash: string;
}
