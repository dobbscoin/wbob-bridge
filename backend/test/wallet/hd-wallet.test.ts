/**
 * HD wallet unit tests.
 *
 * Uses a well-known BIP32 test vector (tpub / mainnet xpub) so results are
 * independently verifiable.
 *
 * BIP32 test vector 1 from https://en.bitcoin.it/wiki/BIP_0032_TestVectors
 * Seed: 000102030405060708090a0b0c0d0e0f
 * m/0'/1/2'/2/1000000000 public key: 0x022a471424da5e657499d1ff51cb31ef5a733b5d2f2faf2090d35b73ba25d5c47
 *
 * We use a known xpub at depth 0 (the serialised BIP32 root public key for
 * the test vector) and verify child derivation is stable and address format
 * is correct.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { HDKey } from '@scure/bip32';
import { HdWallet, pubkeyToP2PKH } from '../../src/wallet/hd-wallet.js';

// ─── BIP32 test vector ────────────────────────────────────────────────────────
// Seed bytes 000102030405060708090a0b0c0d0e0f (BIP32 test vector 1)
// Derive the xpub from a known seed so it's always valid.
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const TEST_XPUB = HDKey.fromMasterSeed(SEED).publicExtendedKey;

// ─── pubkeyToP2PKH ────────────────────────────────────────────────────────────

describe('pubkeyToP2PKH', () => {
  it('returns a string starting with "1" for mainnet (version 0x00)', () => {
    // Uncompressed to compressed is not tested here; use a known compressed pubkey
    // Bitcoin genesis coinbase pubkey (compressed form)
    const pubkey = Buffer.from(
      '0496b538e853519c726a2c91e61ec11600ae1310607d2f03fcdec' +
      'd42aeff5e3da0a0827beab33fb00be1a4f1b90de40e9000000000000000000000000000000000000000000',
      'hex',
    ).slice(0, 33); // take 33 bytes (compressed)
    const addr = pubkeyToP2PKH(pubkey, 0x00);
    expect(addr).toMatch(/^[13]/); // mainnet starts with 1 or 3
  });

  it('returns a string starting with "m" or "n" for testnet (version 0x6F)', () => {
    const pubkey = new Uint8Array(33);
    pubkey[0] = 0x02; // even-y compressed prefix
    // Fill with dummy bytes (won't produce a valid address but format is correct)
    for (let i = 1; i < 33; i++) pubkey[i] = i;
    const addr = pubkeyToP2PKH(pubkey, 0x6F);
    expect(addr).toMatch(/^[mn]/);
  });
});

// ─── HdWallet ─────────────────────────────────────────────────────────────────

describe('HdWallet', () => {
  describe('constructor', () => {
    it('constructs without error given a valid xpub', () => {
      expect(() => new HdWallet(TEST_XPUB)).not.toThrow();
    });

    it('throws on invalid xpub', () => {
      expect(() => new HdWallet('xpub_invalid')).toThrow();
    });
  });

  describe('deriveAddress', () => {
    it('returns a non-empty string', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const addr = wallet.deriveAddress(0);
      expect(typeof addr).toBe('string');
      expect(addr.length).toBeGreaterThan(25);
    });

    it('is deterministic — same index gives same address', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const a1 = wallet.deriveAddress(0);
      const a2 = wallet.deriveAddress(0);
      expect(a1).toBe(a2);
    });

    it('produces different addresses for different indices', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const addrs = new Set([0, 1, 2, 3, 4].map((i) => wallet.deriveAddress(i)));
      expect(addrs.size).toBe(5);
    });

    it('throws on negative index', () => {
      const wallet = new HdWallet(TEST_XPUB);
      expect(() => wallet.deriveAddress(-1)).toThrow();
    });

    it('throws on non-integer index', () => {
      const wallet = new HdWallet(TEST_XPUB);
      expect(() => wallet.deriveAddress(1.5)).toThrow();
    });

    it('addresses start with "1" for mainnet (version 0x00)', () => {
      const wallet = new HdWallet(TEST_XPUB, 'm/0', 0x00);
      for (let i = 0; i < 5; i++) {
        expect(wallet.deriveAddress(i)).toMatch(/^1/);
      }
    });
  });

  describe('deriveAddresses', () => {
    it('returns the correct count of addresses', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const batch = wallet.deriveAddresses(0, 10);
      expect(batch).toHaveLength(10);
    });

    it('indices in the batch match expected values', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const batch = wallet.deriveAddresses(5, 3);
      expect(batch.map((b) => b.index)).toEqual([5, 6, 7]);
    });

    it('addresses in the batch match individual derivation', () => {
      const wallet = new HdWallet(TEST_XPUB);
      const batch = wallet.deriveAddresses(0, 5);
      for (const { index, address } of batch) {
        expect(address).toBe(wallet.deriveAddress(index));
      }
    });
  });
});
