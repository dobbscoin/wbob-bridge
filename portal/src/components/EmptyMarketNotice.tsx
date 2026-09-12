'use client';

import { useEffect, useState } from 'react';

/**
 * Shows a warning ONLY when the wBOB pools are too thin to trade against.
 *
 * Reads the same feed as dobbscoin.info and the Discord bot
 * (subgenius.finance/pools.json) so all three agree. Renders nothing when
 * liquidity is healthy, and nothing when the feed cannot be read — we do not
 * assert a market condition we could not verify.
 *
 * Context: on 2026-08-31 combined TVL across both pools was $0.0038 with zero
 * 24h volume, while this page advertised two live venues. CoW's aggregator
 * returned "no route found" for wBOB.
 */

const POOLS_URL = 'https://subgenius.finance/pools.json';
const TVL_FLOOR_USD = 25; // below this, a swap here will not fill meaningfully

type Pool = { name?: string; dex?: string; tvl_usd?: number };

export function EmptyMarketNotice() {
  const [tvl, setTvl] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(POOLS_URL, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { pools?: Pool[] }) => {
        if (!alive) return;
        const pools = Array.isArray(d?.pools) ? d.pools : [];
        if (!pools.length) return; // unknown, stay quiet
        const sum = pools.reduce(
          (a, p) => a + (Number.isFinite(Number(p?.tvl_usd)) ? Number(p.tvl_usd) : 0),
          0,
        );
        setTvl(sum);
      })
      .catch(() => {
        /* feed unreachable — say nothing rather than guess */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (tvl === null || tvl >= TVL_FLOOR_USD) return null;

  const shown = tvl < 0.01 ? tvl.toFixed(4) : tvl.toFixed(2);

  return (
    <div
      role="status"
      className="rounded-lg border border-red-900/50 bg-red-950/25 px-4 py-3 text-sm text-red-100/85"
    >
      <p className="font-semibold uppercase tracking-wider text-red-300 text-xs">
        There is no wBOB market right now
      </p>
      <p className="mt-1.5 leading-relaxed">
        Combined liquidity across every known wBOB pool is{' '}
        <span className="font-mono tabular-nums">${shown}</span>. A swap below
        will almost certainly fail to route, and any quote you do get will not
        reflect a real price. The bridge itself is unaffected — wrapping and
        unwrapping work normally. This notice disappears on its own once the
        pools are funded.
      </p>
    </div>
  );
}
