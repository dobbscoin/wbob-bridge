import { describe, it, expect } from 'vitest';
import { sanitizeDobbscoinDestination as s, unpayableDestinationReason } from '../../src/gnosis/destination.js';

describe('sanitizeDobbscoinDestination', () => {
  it('passes a real-looking Dobbscoin address through unchanged', () => {
    expect(s('1DR5i1exampleexampleexampleexamp')).toEqual({ value: '1DR5i1exampleexampleexampleexamp', invalid: false });
  });

  it('passes other printable junk through unchanged: the payout step rejects it, as before', () => {
    expect(s('0x1111111111111111111111111111111111111111').invalid).toBe(false);
  });

  it('neutralizes a NUL byte (Postgres TEXT rejects 0x00)', () => {
    const r = s('\u0000');
    expect(r).toEqual({ value: 'INVALID:00', invalid: true, reason: 'contains a NUL byte' });
    expect(r.value.includes('\u0000')).toBe(false);
  });

  it('neutralizes NUL hidden inside a plausible address', () => {
    const r = s('1DR5i1abc\u0000def');
    expect(r.invalid).toBe(true);
    expect(r.value).toBe('INVALID:' + Buffer.from('1DR5i1abc\u0000def').toString('hex'));
  });

  it('caps a huge string so it fits the btree index', () => {
    const r = s('A'.repeat(100_000));
    expect(r.invalid).toBe(true);
    expect(r.reason).toMatch(/too long/);
    expect(r.value.length).toBeLessThan(200);
    expect(r.value).toMatch(/\.\.\(\+99936B\)$/);
  });

  it('neutralizes whitespace, control and non-ASCII characters', () => {
    for (const bad of [' 1abc', '1abc\n', '1abc\t', '1аbc' /* Cyrillic а */, '💩']) {
      const r = s(bad);
      expect(r.invalid).toBe(true);
      expect(r.value).toMatch(/^INVALID:[0-9a-f]+$/);
    }
  });

  it('marks an empty string (the contract forbids it, but never trust that)', () => {
    expect(s('')).toEqual({ value: 'INVALID:', invalid: true, reason: 'empty' });
  });

  it('flags a non-string (viem non-strict decode can yield undefined) instead of storing "undefined"', () => {
    expect(s(undefined)).toEqual({ value: 'INVALID:not-a-string', invalid: true, reason: 'not a string (undefined)' });
    expect(s(42).invalid).toBe(true);
  });

  it('reports every reason that applies, measuring length in bytes', () => {
    expect(s('A'.repeat(200) + '\u0000').reason).toBe('contains a NUL byte; too long (201 bytes)');
    expect(s('💩'.repeat(40)).reason).toBe('too long (160 bytes); contains whitespace, control or non-ASCII characters');
  });

  it('produces a value the payout step can never decode as base58 (":" is not base58)', () => {
    expect(s('\u0000').value).toContain(':');
  });

  it('reserves the INVALID: prefix: an attacker cannot submit a look-alike that skips the flag', () => {
    const r = s('INVALID:00');
    expect(r.invalid).toBe(true);
    expect(r.reason).toBe('uses the reserved INVALID: prefix');
    expect(r.value).toBe('INVALID:' + Buffer.from('INVALID:00').toString('hex'));
  });
});

describe('unpayableDestinationReason (payout-side guard)', () => {
  it('parks every sanitized value up front', () => {
    for (const raw of ['\u0000', 'A'.repeat(5000), 'INVALID:00', '💩', undefined]) {
      expect(unpayableDestinationReason(s(raw).value)).toMatch(/^invalid withdrawal destination/);
    }
  });

  it('leaves real addresses (and printable junk) to the normal payout path', () => {
    expect(unpayableDestinationReason('1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN')).toBeNull();
    expect(unpayableDestinationReason('0x1111111111111111111111111111111111111111')).toBeNull();
  });
});
