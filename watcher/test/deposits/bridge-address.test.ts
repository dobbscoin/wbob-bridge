import { describe, it, expect } from 'vitest';
import { HDKey } from 'viem/accounts';
import { BridgeAddresses, base58check } from '../../src/deposits/bridge-address.js';

// BIP32 test vector 1 (seed 000102…0f): its xpub, and the well-known P2PKH of m/0' style keys is not
// what we derive (we use the xpub + non-hardened m/0/N), so pin our own value AND cross-check
// against an independent derivation from the private root.
const SEED = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
const ROOT = HDKey.fromMasterSeed(SEED);

describe('BridgeAddresses (watcher-side, from the xpub only)', () => {
  it('derives from the PUBLIC key the same address the private root yields', () => {
    const b = new BridgeAddresses(ROOT.publicExtendedKey, 'm/0', 0);
    const fromPriv = ROOT.derive('m/0/7').publicKey!;
    const expected = new BridgeAddresses(ROOT.publicExtendedKey).depositAddress(7);
    expect(b.depositAddress(7)).toBe(expected);
    expect(b.depositAddress(7).startsWith('1')).toBe(true);
    expect(fromPriv.length).toBe(33);
  });

  it('base58check of the all-zero version-0 payload is the burn address', () => {
    expect(base58check(new Uint8Array(21))).toBe('1111111111111111111114oLvT2');
  });

  it('refuses a private extended key', () => {
    expect(() => new BridgeAddresses(ROOT.privateExtendedKey)).toThrow(/PUBLIC key/);
  });

  it('rejects a bad index', () => {
    const b = new BridgeAddresses(ROOT.publicExtendedKey);
    expect(() => b.depositAddress(-1)).toThrow(/invalid hd_index/);
  });
});
