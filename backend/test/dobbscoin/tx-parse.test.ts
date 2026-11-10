/**
 * Review round 9 (found while fixing #1): `o += varint() + 4` read `o` BEFORE
 * varint() advanced it, dropping the scriptSig length byte, so every input
 * after the first (and every output) was read one byte off. Single-input txs
 * happened to parse; two live payouts had 8 and 18 inputs.
 */
import { describe, it, expect } from 'vitest';
import { txInputsFromRawHex, txOutputsFromRawHex } from '../../src/dobbscoin/tx-builder.js';

function txHex(ins: { txid: string; vout: number; sig: string }[], outs: { valueSat: bigint; script: string }[]): string {
  const parts: Buffer[] = [Buffer.from('01000000', 'hex'), Buffer.from([ins.length])];
  for (const i of ins) {
    const v = Buffer.alloc(4); v.writeUInt32LE(i.vout, 0);
    const s = Buffer.from(i.sig, 'hex');
    parts.push(Buffer.from(i.txid, 'hex').reverse(), v, Buffer.from([s.length]), s, Buffer.alloc(4, 0xff));
  }
  parts.push(Buffer.from([outs.length]));
  for (const o of outs) { const a = Buffer.alloc(8); a.writeBigUInt64LE(o.valueSat, 0); const sc = Buffer.from(o.script, 'hex');
    parts.push(a, Buffer.from([sc.length]), sc); }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts).toString('hex');
}

describe('legacy tx parsers', () => {
  const ins = [
    { txid: 'aa'.repeat(32), vout: 0, sig: '47' + '30'.repeat(71) + '21' + '02'.repeat(33) },   // ~106-byte scriptSig
    { txid: 'bb'.repeat(32), vout: 7, sig: '48' + '31'.repeat(72) + '21' + '03'.repeat(33) },
    { txid: 'cc'.repeat(32), vout: 300, sig: '' },
  ];
  const outs = [{ valueSat: 123_456_789n, script: '76a914' + 'dd'.repeat(20) + '88ac' }, { valueSat: 1n, script: '6a' }];
  const hex = txHex(ins, outs);

  it('reads every input of a multi-input tx', () => {
    expect(txInputsFromRawHex(hex)).toEqual(ins.map(({ txid, vout }) => ({ txid, vout })));
  });
  it('reads every output after multi-input scriptSigs', () => {
    expect(txOutputsFromRawHex(hex)).toEqual(outs);
  });
});
