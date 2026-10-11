/**
 * Refund address detection — the deposit's first input's previous output.
 *
 * Fixture: a real Dobbscoin mainnet P2PKH output as dobbscoind 0.14 reports it
 * through `getrawtransaction <txid> 1` (read on vps3, 2026-10-11).
 */

import { describe, it, expect } from 'vitest';
import { resolveSender, detectDepositSender, hash160ToP2PKH } from '../../src/dobbscoin/sender.js';
import { RpcCallError, RpcNetworkError, type RpcVerboseTx } from '../../src/dobbscoin/rpc.js';

const PREV_TXID = '6d77f957252a93d5c7b05fe5f4f48d4dac77ad6a8fdae128fbf6dee8522973a4';
const DEPOSIT_TXID = 'd'.repeat(64);
const SENDER = '1A2it4ZpSr4GPFifF9GEoLfgbmbxVGKCcK';
const P2PKH_HEX = '76a914630c820b86b969e01a0d4ee797c19d1949d7e88188ac';

function depositTx(vin: RpcVerboseTx['vin']): RpcVerboseTx {
  return {
    txid: DEPOSIT_TXID,
    vin,
    vout: [{ value: 10, n: 0, scriptPubKey: { hex: '76a914' + '11'.repeat(20) + '88ac', type: 'pubkeyhash', addresses: ['1bridge'] } }],
  };
}

function prevTx(spk: RpcVerboseTx['vout'][number]['scriptPubKey'], n = 1): RpcVerboseTx {
  return {
    txid: PREV_TXID,
    vin: [{ txid: 'e'.repeat(64), vout: 0 }],
    vout: [
      { value: 1, n: 0, scriptPubKey: { hex: '76a914' + '22'.repeat(20) + '88ac', type: 'pubkeyhash', addresses: ['1other'] } },
      { value: 50, n, scriptPubKey: spk },
    ],
  };
}

const goodSpk = { hex: P2PKH_HEX, type: 'pubkeyhash', addresses: [SENDER] };

describe('hash160ToP2PKH', () => {
  it('encodes the fixture script hash to the node-reported address (version 0x00)', () => {
    expect(hash160ToP2PKH('630c820b86b969e01a0d4ee797c19d1949d7e881', 0x00)).toBe(SENDER);
  });
});

describe('resolveSender', () => {
  it('P2PKH first input → that address', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]), prevTx(goodSpk), 0);
    expect(r).toMatchObject({ ok: true, address: SENDER });
    expect(r.detail.multiInput).toBe(false);
  });

  it('newer node shape (scriptPubKey.address) is accepted too', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]),
      prevTx({ hex: P2PKH_HEX, type: 'pubkeyhash', address: SENDER }), 0);
    expect(r).toMatchObject({ ok: true, address: SENDER });
  });

  it('multi-input deposit follows vin[0] and records that there were others', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }, { txid: 'f'.repeat(64), vout: 3 }]), prevTx(goodSpk), 0);
    expect(r).toMatchObject({ ok: true, address: SENDER });
    expect(r.detail).toMatchObject({ inputCount: 2, multiInput: true });
  });

  it('coinbase input → not determinable', () => {
    const r = resolveSender(depositTx([{ coinbase: '03abcdef' }]), null, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/coinbase/);
  });

  it('no inputs → not determinable', () => {
    expect(resolveSender(depositTx([]), null, 0).ok).toBe(false);
  });

  it('previous tx missing → not determinable (no guessing)', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]), null, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/);
  });

  it('P2SH sender → not determinable (tx builder pays P2PKH only)', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]),
      prevTx({ hex: 'a914' + '33'.repeat(20) + '87', type: 'scripthash', addresses: ['3abc'] }), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scripthash/);
  });

  it('pay-to-pubkey / nonstandard → not determinable', () => {
    for (const type of ['pubkey', 'nonstandard', 'multisig', 'nulldata']) {
      const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]), prevTx({ hex: '51', type }), 0);
      expect(r.ok).toBe(false);
    }
  });

  it('labelled P2PKH but script is not the template → refused', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]),
      prevTx({ hex: '76a914' + '44'.repeat(20) + '88ac51', type: 'pubkeyhash', addresses: [SENDER] }), 0);
    expect(r.ok).toBe(false);
  });

  it('node address disagreeing with the decoded script → refused', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]),
      prevTx({ hex: P2PKH_HEX, type: 'pubkeyhash', addresses: ['1SomethingElse'] }), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/disagrees/);
  });

  it('wrong version byte → decoded address disagrees → refused, not mis-sent', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]), prevTx(goodSpk), 0x6f);
    expect(r.ok).toBe(false);
  });

  it('referenced output index missing → refused', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 7 }]), prevTx(goodSpk), 0);
    expect(r.ok).toBe(false);
  });

  it('sender is a bridge address → refused (never refund to ourselves)', () => {
    const r = resolveSender(depositTx([{ txid: PREV_TXID, vout: 1 }]), prevTx(goodSpk), 0, new Set([SENDER]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/bridge/);
  });
});

describe('detectDepositSender (RPC)', () => {
  const dep = depositTx([{ txid: PREV_TXID, vout: 1 }]);

  it('fetches the deposit and the previous tx', async () => {
    const calls: string[] = [];
    const rpc = {
      getRawTransactionVerbose: async (txid: string) => {
        calls.push(txid);
        return txid === DEPOSIT_TXID ? dep : prevTx(goodSpk);
      },
    };
    const r = await detectDepositSender(rpc, DEPOSIT_TXID, 0);
    expect(r).toMatchObject({ ok: true, address: SENDER });
    expect(calls).toEqual([DEPOSIT_TXID, PREV_TXID]);
  });

  it('RPC -5 for the previous tx is a verdict: not determinable', async () => {
    const rpc = {
      getRawTransactionVerbose: async (txid: string) => {
        if (txid === DEPOSIT_TXID) return dep;
        throw new RpcCallError('getrawtransaction', -5, 'No such mempool or blockchain transaction');
      },
    };
    const r = await detectDepositSender(rpc, DEPOSIT_TXID, 0);
    expect(r.ok).toBe(false);
  });

  it('a network error is NOT a verdict: it throws so the caller retries', async () => {
    const rpc = {
      getRawTransactionVerbose: async (txid: string) => {
        if (txid === DEPOSIT_TXID) return dep;
        throw new RpcNetworkError('getrawtransaction', new Error('ECONNREFUSED'));
      },
    };
    await expect(detectDepositSender(rpc, DEPOSIT_TXID, 0)).rejects.toThrow(/network/);
  });

  it('coinbase deposit does not even look up a previous tx', async () => {
    const calls: string[] = [];
    const rpc = {
      getRawTransactionVerbose: async (txid: string) => {
        calls.push(txid);
        return depositTx([{ coinbase: '03' }]);
      },
    };
    const r = await detectDepositSender(rpc, DEPOSIT_TXID, 0);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([DEPOSIT_TXID]);
  });
});
