/**
 * DobbscoinRpcClient unit tests.
 *
 * HTTP is mocked via global fetch replacement — no actual node required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DobbscoinRpcClient, RpcCallError, RpcNetworkError, btcToSatoshis } from '../../src/rpc/client.js';
import type { RpcConfig } from '../../src/rpc/client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONFIG: RpcConfig = {
  url: 'http://127.0.0.1:8332',
  username: 'user',
  password: 'pass',
};

function makeOkResponse<T>(result: T): Response {
  return new Response(
    JSON.stringify({ result, error: null, id: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeErrorResponse(code: number, message: string): Response {
  return new Response(
    JSON.stringify({ result: null, error: { code, message }, id: 1 }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
}

// ─── btcToSatoshis ────────────────────────────────────────────────────────────

describe('btcToSatoshis', () => {
  it('converts 1.0 BTC to 100000000 sat', () => {
    expect(btcToSatoshis(1.0)).toBe(100_000_000n);
  });

  it('converts 0.00000001 BTC (1 sat)', () => {
    expect(btcToSatoshis(0.00000001)).toBe(1n);
  });

  it('converts 21000000 BTC (max supply)', () => {
    expect(btcToSatoshis(21_000_000)).toBe(2_100_000_000_000_000n);
  });

  it('handles floating-point imprecision gracefully via rounding', () => {
    // 0.1 BTC in floating point is slightly off; rounding should give exactly 10000000
    expect(btcToSatoshis(0.1)).toBe(10_000_000n);
  });

  it('converts zero', () => {
    expect(btcToSatoshis(0)).toBe(0n);
  });
});

// ─── RPC call ─────────────────────────────────────────────────────────────────

describe('DobbscoinRpcClient', () => {
  let client: DobbscoinRpcClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new DobbscoinRpcClient(CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('call()', () => {
    it('sends correct JSON-RPC body', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('abc123'));

      await client.call('getbestblockhash');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(CONFIG.url);

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['method']).toBe('getbestblockhash');
      expect(body['jsonrpc']).toBe('1.1');
      expect(Array.isArray(body['params'])).toBe(true);
    });

    it('sets Authorization header with base64 credentials', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('x'));

      await client.call('getbestblockhash');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
      expect(headers['Authorization']).toBe(expected);
    });

    it('returns result on success', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('deadbeef'));
      const result = await client.call<string>('getbestblockhash');
      expect(result).toBe('deadbeef');
    });

    it('throws RpcCallError when error field is set', async () => {
      fetchMock.mockResolvedValueOnce(makeErrorResponse(-8, 'Block not found'));

      await expect(client.call('getblock', ['bad'])).rejects.toThrow(RpcCallError);
    });

    it('RpcCallError carries code and method', async () => {
      fetchMock.mockResolvedValueOnce(makeErrorResponse(-8, 'Block not found'));

      let err: RpcCallError | undefined;
      try {
        await client.call('getblock', ['bad']);
      } catch (e) {
        err = e as RpcCallError;
      }

      expect(err).toBeDefined();
      expect(err!.code).toBe(-8);
      expect(err!.method).toBe('getblock');
    });

    it('throws RpcNetworkError on fetch failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.call('getbestblockhash')).rejects.toThrow(RpcNetworkError);
    });

    it('throws RpcNetworkError on non-JSON response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(client.call('getbestblockhash')).rejects.toThrow(RpcNetworkError);
    });

    it('passes params array correctly', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({}));

      await client.call('getblock', ['abc', 2]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['params']).toEqual(['abc', 2]);
    });
  });

  describe('getBlockchainInfo()', () => {
    it('calls getblockchaininfo with no params', async () => {
      const info = { chain: 'main', blocks: 800_000, headers: 800_000, bestblockhash: 'abc' };
      fetchMock.mockResolvedValueOnce(makeOkResponse(info));

      const result = await client.getBlockchainInfo();
      expect(result.blocks).toBe(800_000);
      expect(result.bestblockhash).toBe('abc');
    });
  });

  describe('getBestBlockHash()', () => {
    it('returns the block hash string', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('000abc'));
      const hash = await client.getBestBlockHash();
      expect(hash).toBe('000abc');
    });
  });

  describe('getBlockHash()', () => {
    it('passes height as param', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse('000def'));
      const hash = await client.getBlockHash(12345);
      expect(hash).toBe('000def');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['params']).toEqual([12345]);
    });
  });

  describe('getBlockHeader()', () => {
    it('returns BlockHeader with hash/height/previousblockhash', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({
        hash: 'aaa',
        height: 100,
        previousblockhash: 'bbb',
      }));

      const header = await client.getBlockHeader('aaa');
      expect(header.hash).toBe('aaa');
      expect(header.height).toBe(100);
      expect(header.previousblockhash).toBe('bbb');
    });

    it('uses empty string for missing previousblockhash (genesis)', async () => {
      fetchMock.mockResolvedValueOnce(makeOkResponse({
        hash: 'genesis',
        height: 0,
      }));

      const header = await client.getBlockHeader('genesis');
      expect(header.previousblockhash).toBe('');
    });
  });
});
