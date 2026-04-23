/**
 * HD wallet — Dobbscoin deposit address derivation.
 *
 * The bridge operator provides an xpub (extended public key).
 * Private keys never touch this server — only public key derivation happens here.
 * The xpub should come from a hardware wallet or cold storage.
 *
 * Address format: P2PKH (pay-to-public-key-hash), same as Bitcoin.
 * Version byte 0x00 = mainnet addresses starting with '1'.
 * Version byte 0x6F = testnet addresses starting with 'm'/'n'.
 *
 * Derivation: xpub / hdDerivationPath / index
 * Example: if hdDerivationPath = "m/0" and index = 5, derives m/0/5 relative to xpub root.
 */

import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

// ─── Base58Check with Bitcoin's double-SHA256 checksum ───────────────────────
// @scure/base's base58check(fn) uses fn(fn(data)) as the checksum.
// Passing sha256 gives sha256(sha256(data)) — the Bitcoin standard double-SHA256.
const b58check = base58check(sha256);

// ─── HdWallet ─────────────────────────────────────────────────────────────────

export class HdWallet {
  private readonly rootKey: HDKey;
  private readonly pathPrefix: string;
  private readonly versionByte: number;

  /**
   * @param xpub          BIP32 extended public key string (xpub...)
   * @param pathPrefix    Derivation path relative to xpub root, e.g. "m/0"
   * @param versionByte   P2PKH version byte: 0x00 mainnet, 0x6F testnet
   */
  constructor(xpub: string, pathPrefix = 'm/0', versionByte = 0x00) {
    this.rootKey = HDKey.fromExtendedKey(xpub);
    this.pathPrefix = pathPrefix;
    this.versionByte = versionByte;
  }

  /**
   * Derive the Dobbscoin deposit address at the given index.
   * The full path is: <pathPrefix>/<index>
   */
  deriveAddress(index: number): string {
    if (index < 0 || !Number.isInteger(index)) {
      throw new Error(`Invalid HD index: ${index}`);
    }

    const child = this.rootKey.derive(`${this.pathPrefix}/${index}`);
    const pubkey = child.publicKey;
    if (pubkey === null || pubkey === undefined) {
      throw new Error(`Failed to derive public key at index ${index}`);
    }

    return pubkeyToP2PKH(pubkey, this.versionByte);
  }

  /**
   * Derive a batch of addresses starting at fromIndex (inclusive).
   */
  deriveAddresses(fromIndex: number, count: number): Array<{ index: number; address: string }> {
    const result: Array<{ index: number; address: string }> = [];
    for (let i = fromIndex; i < fromIndex + count; i++) {
      result.push({ index: i, address: this.deriveAddress(i) });
    }
    return result;
  }
}

// ─── P2PKH address derivation ─────────────────────────────────────────────────

/**
 * Compute a P2PKH address from a compressed 33-byte public key.
 * Formula: Base58Check( [versionByte] ++ RIPEMD160(SHA256(pubkey)) )
 */
export function pubkeyToP2PKH(pubkey: Uint8Array, versionByte = 0x00): string {
  const sha = sha256(pubkey);
  const hash160 = ripemd160(sha);

  const payload = new Uint8Array(21);
  payload[0] = versionByte;
  payload.set(hash160, 1);

  return b58check.encode(payload);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createHdWallet(
  xpub: string,
  pathPrefix = 'm/0',
  versionByte = 0x00,
): HdWallet {
  return new HdWallet(xpub, pathPrefix, versionByte);
}
