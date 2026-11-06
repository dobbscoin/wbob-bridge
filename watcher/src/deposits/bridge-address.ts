/**
 * The bridge's own deposit addresses, derived HERE from HD_WALLET_XPUB (in the
 * watcher's environment, not the database) — the same formula as the backend's
 * HdWallet (backend/src/wallet/hd-wallet.ts):
 *
 *   address(index) = Base58Check( [versionByte] ++ RIPEMD160(SHA256(pubkey(xpub / <path>/<index>))) )
 *
 * Why the watcher needs it (2026-11 review): the pre-signing node check compared
 * the deposit output with source_deposits.deposit_address — a DB value. Anyone
 * who can write the DB could point a row at an address THEY control, send (BOB)
 * to it, and collect wBOB while keeping the (BOB). Each watcher now refuses to
 * sign unless the output pays the address the bridge's xpub yields at hd_index.
 *
 * Uses only viem (a declared dependency): HDKey, sha256, ripemd160.
 */
import { HDKey } from 'viem/accounts';
import { sha256, ripemd160 } from 'viem';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export function base58check(payload: Uint8Array): string {
  const check = sha256(sha256(payload, 'bytes'), 'bytes').subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload); full.set(check, payload.length);
  return base58(full);
}

export function pubkeyToP2PKH(pubkey: Uint8Array, versionByte = 0x00): string {
  const h160 = ripemd160(sha256(pubkey, 'bytes'), 'bytes');
  const payload = new Uint8Array(21);
  payload[0] = versionByte;
  payload.set(h160, 1);
  return base58check(payload);
}

export class BridgeAddresses {
  private readonly root: HDKey;
  private readonly cache = new Map<number, string>();

  constructor(xpub: string, private readonly pathPrefix = 'm/0', private readonly versionByte = 0x00) {
    if (!/^[tx]pub/.test(xpub)) throw new Error('HD_WALLET_XPUB must be an extended PUBLIC key (xpub/tpub), never a private one');
    this.root = HDKey.fromExtendedKey(xpub);
  }

  /** The bridge's deposit address at `index`. Throws on a bad index. */
  depositAddress(index: number): string {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid hd_index ${index}`);
    const hit = this.cache.get(index);
    if (hit) return hit;
    const pub = this.root.derive(`${this.pathPrefix}/${index}`).publicKey;
    if (!pub) throw new Error(`no public key at ${this.pathPrefix}/${index}`);
    const a = pubkeyToP2PKH(pub, this.versionByte);
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(index, a);
    return a;
  }
}
