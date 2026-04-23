/**
 * computeDepositId unit tests.
 *
 * These verify:
 *  1. The function runs without error and returns a 32-byte hex string
 *  2. Different inputs produce different digests
 *  3. Same inputs always produce the same digest (determinism)
 */

import { describe, it, expect } from 'vitest';
import { computeDepositId } from '../../src/deposits/deposit-id.js';
import type { DepositIdParams } from '@wbob/shared';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PARAMS: DepositIdParams = {
  sourceChainName:        'dobbscoin-mainnet',
  dobbscoinTxid:          'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  vout:                   0,
  depositAddress:         'D1TestDepositAddressXXXXXXXXXXXXXXXXXXXX',
  rawAmountSat:           100_000_000n,
  recipientGnosisAddress: '0x1234567890123456789012345678901234567890',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeDepositId', () => {
  it('returns a 0x-prefixed 66-char hex string (32 bytes)', () => {
    const id = computeDepositId(BASE_PARAMS);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same output', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({ ...BASE_PARAMS });
    expect(id1).toBe(id2);
  });

  it('different txid produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({
      ...BASE_PARAMS,
      dobbscoinTxid: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
    expect(id1).not.toBe(id2);
  });

  it('different vout produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({ ...BASE_PARAMS, vout: 1 });
    expect(id1).not.toBe(id2);
  });

  it('different amount produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({ ...BASE_PARAMS, rawAmountSat: 200_000_000n });
    expect(id1).not.toBe(id2);
  });

  it('different depositAddress produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({ ...BASE_PARAMS, depositAddress: 'D2AnotherAddressXXXXXXXXXXXXXXXXXXXXXXXX' });
    expect(id1).not.toBe(id2);
  });

  it('different recipient produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({
      ...BASE_PARAMS,
      recipientGnosisAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    expect(id1).not.toBe(id2);
  });

  it('different sourceChainName produces different depositId', () => {
    const id1 = computeDepositId(BASE_PARAMS);
    const id2 = computeDepositId({ ...BASE_PARAMS, sourceChainName: 'dobbscoin-testnet' });
    expect(id1).not.toBe(id2);
  });

  it('works with zero satoshi amount', () => {
    const id = computeDepositId({ ...BASE_PARAMS, rawAmountSat: 0n });
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('works with large satoshi amounts', () => {
    const id = computeDepositId({ ...BASE_PARAMS, rawAmountSat: 2_100_000_000_000_000n });
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
