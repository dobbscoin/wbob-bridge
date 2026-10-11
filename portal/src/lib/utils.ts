/** Convert satoshis (bigint) to a human-readable BOB string, e.g. "0.00100000" */
export function satsToBob(sats: bigint | string | number): string {
  const n = BigInt(sats);
  const whole = n / 100_000_000n;
  const frac  = n % 100_000_000n;
  return `${whole}.${frac.toString().padStart(8, '0')}`;
}

/** Convert a BOB decimal string (e.g. "0.001") to satoshis as bigint. */
export function bobToSats(bob: string): bigint {
  const trimmed = bob.trim();
  if (!trimmed || isNaN(Number(trimmed))) throw new Error('Invalid BOB amount');
  const [whole = '0', frac = ''] = trimmed.split('.');
  const fracPadded = frac.slice(0, 8).padEnd(8, '0');
  return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
}

/** Shorten a 0x address for display: 0x1234...5678 */
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Shorten a txid/hash for display */
export function shortHash(hash: string, chars = 8): string {
  if (!hash || hash.length < chars * 2) return hash;
  return `${hash.slice(0, chars)}…${hash.slice(-chars)}`;
}

/** Format a Date (or ISO string) as relative time or absolute */
export function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  const hours   = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Gnosis chain explorer URL */
export const GNOSIS_EXPLORER = 'https://gnosisscan.io';

export function gnosisExplorerTx(hash: string): string {
  return `${GNOSIS_EXPLORER}/tx/${hash}`;
}

/** Dobbscoin explorer URL */
export const DOBBSCOIN_EXPLORER = 'https://explorer.dobbscoin.info';

export function dobbscoinExplorerTx(txid: string): string {
  return `${DOBBSCOIN_EXPLORER}/tx/${txid}`;
}

export function dobbscoinExplorerAddress(addr: string): string {
  return `${DOBBSCOIN_EXPLORER}/address/${addr}`;
}

/**
 * Satoshis → grouped BOB with trailing zeros trimmed, exact (bigint, no float):
 * "100000000000000" → "1,000,000", "1" → "0.00000001".
 */
export function fmtBob(sats: bigint | string | number): string {
  const n = BigInt(sats);
  const neg = n < 0n;
  const v = neg ? -n : n;
  const whole = (v / 100_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Seconds → "5h 07m 09s" (hours omitted under an hour). */
export function fmtCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}h ${mm}m ${ss}s` : `${m}m ${ss}s`;
}
