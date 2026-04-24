/**
 * Dobbscoin RPC client for the backend.
 * Same Bitcoin Core JSON-RPC interface as the watcher's client,
 * with the addition of getRawTransactionHex (needed for PSBT input signing).
 */

export interface DobbscoinRpcConfig {
  url: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export class RpcCallError extends Error {
  constructor(public readonly method: string, public readonly code: number, msg: string) {
    super(`RPC ${method} error ${code}: ${msg}`);
    this.name = 'RpcCallError';
  }
}

export class RpcNetworkError extends Error {
  constructor(public readonly method: string, cause: unknown) {
    super(`RPC ${method} network error: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RpcNetworkError';
    this.cause = cause;
  }
}

export interface RpcVout {
  value: number;
  n: number;
  scriptPubKey: { asm: string; hex: string; type: string; address?: string };
}

export interface RpcUnspent {
  txid: string;
  vout: number;
  address: string;
  amount: number;   // BTC float
  confirmations: number;
  spendable: boolean;
}

let _id = 1;

export class DobbscoinBackendRpc {
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: DobbscoinRpcConfig) {
    this.auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = _id++;
    let res: Response;
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${this.auth}` },
        body: JSON.stringify({ jsonrpc: '1.1', id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RpcNetworkError(method, e);
    }
    type Env = { result: T; error: { code: number; message: string } | null };
    let env: Env;
    try { env = (await res.json()) as Env; }
    catch { throw new RpcNetworkError(method, new Error(`Non-JSON HTTP ${res.status}`)); }
    if (env.error) throw new RpcCallError(method, env.error.code, env.error.message);
    return env.result;
  }

  /**
   * Returns raw transaction as hex string.
   *
   * Dobbscoin is a pre-0.12 Bitcoin Core fork: the `verbose` flag must be
   * passed as an int (0/1), not a bool — bool triggers
   * `value is type bool, expected int`. (Note this is the opposite convention
   * from `getblock` on the same node, which wants bool.)
   */
  getRawTransactionHex(txid: string): Promise<string> {
    return this.call<string>('getrawtransaction', [txid, 0]);
  }

  /** Returns current chain tip info. */
  getBestBlockHash(): Promise<string> {
    return this.call<string>('getbestblockhash');
  }

  /** Broadcast a signed raw transaction. Returns txid. */
  sendRawTransaction(hexTx: string): Promise<string> {
    return this.call<string>('sendrawtransaction', [hexTx]);
  }

  /** Returns UTXOs tracked by the node wallet (requires wallet mode). */
  listUnspent(minConf = 1, addresses?: string[]): Promise<RpcUnspent[]> {
    const params: unknown[] = [minConf, 9_999_999];
    if (addresses) params.push(addresses);
    return this.call<RpcUnspent[]>('listunspent', params);
  }

  /** Returns confirmations for a txid. Returns 0 if unconfirmed, -1 if not found. */
  async getConfirmations(txid: string): Promise<number> {
    type RawTx = { confirmations?: number };
    try {
      const tx = await this.call<RawTx>('getrawtransaction', [txid, 1]);
      return tx.confirmations ?? 0;
    } catch (e) {
      if (e instanceof RpcCallError && e.code === -5) return -1; // not found
      throw e;
    }
  }
}
