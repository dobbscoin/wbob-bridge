// Client-side helpers for the proof-of-reserves card and page.
// Type-only import: nothing from the server reader is bundled into the browser.
import type { ReservesReport } from './reserves';

export type { ReservesReport };

export async function fetchReserves(): Promise<ReservesReport> {
  const res = await fetch('/api/reserves', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ReservesReport>;
}

/** "7980.34816493" → "7,980.34". Cuts, never rounds, so a figure is never shown larger than it is. */
export function fmtBob(v: string, places = 2): string {
  const [w = '0', f = ''] = v.split('.');
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places > 0 ? `${whole}.${f.padEnd(places, '0').slice(0, places)}` : whole;
}

/** "1.002510" → "1.00" at 2 places. Cuts, never rounds: 0.9999 shows as 0.99, not 1.00. */
export function fmtRatio(v: string, places: number): string {
  const [w = '0', f = ''] = v.split('.');
  return `${w}.${f.padEnd(places, '0').slice(0, places)}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
