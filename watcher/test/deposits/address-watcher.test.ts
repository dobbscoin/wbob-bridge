/**
 * Address watcher unit tests — pure, no I/O.
 */

import { describe, it, expect } from 'vitest';
import { matchTransaction, matchBlock } from '../../src/deposits/address-watcher.js';
import type { RpcRawTransaction, RpcBlock } from '../../src/rpc/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTx(
  txid: string,
  outputs: Array<{ value: number; address?: string }>,
): RpcRawTransaction {
  return {
    txid,
    hash: txid,
    version: 1,
    size: 250,
    vsize: 250,
    weight: 1000,
    locktime: 0,
    vin: [],
    vout: outputs.map((o, n) => ({
      value: o.value,
      n,
      scriptPubKey: {
        asm: '',
        hex: '',
        type: 'pubkeyhash',
        ...(o.address ? { address: o.address } : {}),
      },
    })),
    hex: '',
  };
}

function makeBlock(txs: RpcRawTransaction[], height = 100, hash = 'blockhash'): RpcBlock {
  return {
    hash,
    confirmations: 1,
    height,
    tx: txs,
  };
}

// ─── matchTransaction ─────────────────────────────────────────────────────────

describe('matchTransaction', () => {
  const WATCHED = new Set(['D1DepositAddr', 'D2DepositAddr']);

  it('returns empty array when no outputs match', () => {
    const tx = makeTx('tx1', [{ value: 1.0, address: 'D9NotWatched' }]);
    expect(matchTransaction(tx, WATCHED)).toHaveLength(0);
  });

  it('returns one match for a single matching output', () => {
    const tx = makeTx('tx1', [{ value: 0.5, address: 'D1DepositAddr' }]);
    const matches = matchTransaction(tx, WATCHED);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.txid).toBe('tx1');
    expect(matches[0]!.vout).toBe(0);
    expect(matches[0]!.amountSat).toBe(50_000_000n);
    expect(matches[0]!.depositAddress).toBe('D1DepositAddr');
  });

  it('returns multiple matches when multiple outputs match', () => {
    const tx = makeTx('tx2', [
      { value: 1.0, address: 'D1DepositAddr' },
      { value: 2.0, address: 'D2DepositAddr' },
    ]);
    const matches = matchTransaction(tx, WATCHED);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.vout).toBe(0);
    expect(matches[1]!.vout).toBe(1);
  });

  it('only matches watched outputs even if tx has many outputs', () => {
    const tx = makeTx('tx3', [
      { value: 1.0, address: 'D9NotWatched' },
      { value: 0.1, address: 'D1DepositAddr' },
      { value: 0.2, address: 'D8NotWatched' },
    ]);
    const matches = matchTransaction(tx, WATCHED);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.vout).toBe(1);
  });

  it('converts BTC value to satoshis correctly', () => {
    const tx = makeTx('tx4', [{ value: 0.00000001, address: 'D1DepositAddr' }]);
    const matches = matchTransaction(tx, WATCHED);
    expect(matches[0]!.amountSat).toBe(1n);
  });

  it('attaches blockHash and blockHeight when provided', () => {
    const tx = makeTx('tx5', [{ value: 1.0, address: 'D1DepositAddr' }]);
    const matches = matchTransaction(tx, WATCHED, 'blockabc', 500);
    expect(matches[0]!.blockHash).toBe('blockabc');
    expect(matches[0]!.blockHeight).toBe(500);
  });

  it('leaves blockHash/blockHeight undefined for mempool tx', () => {
    const tx = makeTx('tx6', [{ value: 1.0, address: 'D1DepositAddr' }]);
    const matches = matchTransaction(tx, WATCHED);
    expect(matches[0]!.blockHash).toBeUndefined();
    expect(matches[0]!.blockHeight).toBeUndefined();
  });

  it('skips outputs without an address (OP_RETURN etc)', () => {
    const tx = makeTx('tx7', [
      { value: 0 },                                // no address
      { value: 1.0, address: 'D1DepositAddr' },
    ]);
    const matches = matchTransaction(tx, WATCHED);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.vout).toBe(1);
  });

  it('returns empty for empty watched set', () => {
    const tx = makeTx('tx8', [{ value: 1.0, address: 'D1DepositAddr' }]);
    expect(matchTransaction(tx, new Set())).toHaveLength(0);
  });
});

// ─── matchBlock ───────────────────────────────────────────────────────────────

describe('matchBlock', () => {
  const WATCHED = new Set(['D1DepositAddr']);

  it('returns empty for a block with no matching txs', () => {
    const block = makeBlock([
      makeTx('tx1', [{ value: 1.0, address: 'D9Other' }]),
    ]);
    expect(matchBlock(block, WATCHED)).toHaveLength(0);
  });

  it('aggregates matches across multiple transactions', () => {
    const block = makeBlock([
      makeTx('tx1', [{ value: 0.5, address: 'D1DepositAddr' }]),
      makeTx('tx2', [{ value: 0.2, address: 'D9Other' }]),
      makeTx('tx3', [{ value: 1.0, address: 'D1DepositAddr' }]),
    ], 200, 'bh200');

    const matches = matchBlock(block, WATCHED);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.txid).toBe('tx1');
    expect(matches[1]!.txid).toBe('tx3');
    // All matches get the block metadata
    for (const m of matches) {
      expect(m.blockHash).toBe('bh200');
      expect(m.blockHeight).toBe(200);
    }
  });

  it('returns empty for empty block', () => {
    const block = makeBlock([]);
    expect(matchBlock(block, WATCHED)).toHaveLength(0);
  });
});
