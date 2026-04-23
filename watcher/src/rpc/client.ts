/**
 * Bitcoin Core JSON-RPC client.
 *
 * Uses native fetch (Node 18+). Covers only the methods the watcher needs.
 * All amounts returned in satoshis (bigint) — never floats.
 */

import type {
  RpcResponse,
  RpcBlock,
  RpcRawTransaction,
  RpcBlockchainInfo,
  RpcMempoolMap,
  BlockHeader,
} from './types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface RpcConfig {
  url: string;        // e.g. http://127.0.0.1:8332
  username: string;
  password: string;
  /** Timeout in ms. Default 30 000. */
  timeoutMs?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class RpcCallError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
  ) {
    super(`RPC ${method} error ${code}: ${message}`);
    this.name = 'RpcCallError';
  }
}

export class RpcNetworkError extends Error {
  constructor(
    public readonly method: string,
    cause: unknown,
  ) {
    super(`RPC ${method} network error: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RpcNetworkError';
    this.cause = cause;
  }
}

// ─── Bitcoin amounts ──────────────────────────────────────────────────────────

/** Convert BTC float (as returned by RPC) to satoshis (bigint). */
export function btcToSatoshis(btc: number): bigint {
  // Round to avoid floating-point drift (BTC is 8 decimal places)
  return BigInt(Math.round(btc * 1e8));
}

// ─── Client ───────────────────────────────────────────────────────────────────

let _nextId = 1;

export class DobbscoinRpcClient {
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: RpcConfig) {
    this.auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ── Raw call ────────────────────────────────────────────────────────────────

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = _nextId++;
    const body = JSON.stringify({ jsonrpc: '1.1', id, method, params });

    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${this.auth}`,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RpcNetworkError(method, err);
    }

    let envelope: RpcResponse<T>;
    try {
      envelope = (await response.json()) as RpcResponse<T>;
    } catch {
      throw new RpcNetworkError(method, new Error(`Non-JSON response: HTTP ${response.status}`));
    }

    if (envelope.error !== null) {
      throw new RpcCallError(method, envelope.error.code, envelope.error.message);
    }

    return envelope.result;
  }

  // ── Typed methods ───────────────────────────────────────────────────────────

  /** Returns the current chain tip info. */
  async getBlockchainInfo(): Promise<RpcBlockchainInfo> {
    return this.call<RpcBlockchainInfo>('getblockchaininfo');
  }

  /** Returns the block hash at the given height. */
  async getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  /**
   * Returns the full block with all transactions decoded.
   *
   * Dobbscoin is a pre-0.12 Bitcoin Core fork: `getblock` only accepts a bool
   * verbose flag (true → tx is txid[], not decoded txs), and there is no
   * `getblockheader`. So we fetch the block envelope with verbose=true, then
   * pull each tx via `getrawtransaction` (requires -txindex on the node).
   */
  async getBlock(blockHash: string): Promise<RpcBlock> {
    const raw = await this.call<{
      hash: string;
      height: number;
      confirmations: number;
      previousblockhash?: string;
      tx: string[];
    }>('getblock', [blockHash, true]);

    const txs = await Promise.all(raw.tx.map((txid) => this.getRawTransaction(txid)));

    return {
      hash:              raw.hash,
      height:            raw.height,
      confirmations:     raw.confirmations,
      ...(raw.previousblockhash !== undefined ? { previousblockhash: raw.previousblockhash } : {}),
      tx:                txs,
    };
  }

  /** Returns the subset of block fields needed for reorg tracking. */
  async getBlockHeader(blockHash: string): Promise<BlockHeader> {
    const raw = await this.call<{
      hash: string;
      height: number;
      previousblockhash?: string;
    }>('getblock', [blockHash, true]);
    return {
      hash: raw.hash,
      height: raw.height,
      previousblockhash: raw.previousblockhash ?? '',
    };
  }

  /**
   * Returns a raw decoded transaction. Must be in the mempool or (-txindex) tx index.
   * Dobbscoin's pre-0.12 Core wants the verbose flag as an int (bool triggers
   * "value is type bool, expected int"); modern Core accepts either.
   */
  async getRawTransaction(txid: string): Promise<RpcRawTransaction> {
    return this.call<RpcRawTransaction>('getrawtransaction', [txid, 1]);
  }

  /** Returns txid → entry map for all mempool transactions. */
  async getRawMempool(): Promise<RpcMempoolMap> {
    return this.call<RpcMempoolMap>('getrawmempool', [true]);
  }

  /**
   * Returns the best block hash (chain tip).
   * Cheaper than getBlockchainInfo when only the hash is needed.
   */
  async getBestBlockHash(): Promise<string> {
    return this.call<string>('getbestblockhash');
  }
}
