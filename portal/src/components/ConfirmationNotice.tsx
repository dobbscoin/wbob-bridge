// ─── ConfirmationNotice ───────────────────────────────────────────────────────
//
// User-facing explainer for the inbound confirmation wait (BOB → wBOB).
//
// The watcher's MIN/FINAL Dobbscoin confirmation thresholds are 30/60
// (~1h to "confirmed", ~2h to mint), tuned for 51%-attack hardening.
// (BOB) is a low-hash scrypt chain, so a couple hours of confirmations stop
// rented-hash reorgs from un-spending a deposit already minted as wBOB on
// Gnosis. A 100-block consensus reorg cap also lands at block 1,888,808
// (~2026-07-16), after which 100 confs is provable finality.
//
// The wait applies to *inbound* (BOB → wBOB) only. Withdrawals (wBOB → BOB)
// settle in roughly one Gnosis block-time on the burn side (~1 min), since
// Gnosis isn't the vulnerable chain.

export function InboundConfirmationBanner() {
  return (
    <div
      className="relative overflow-hidden rounded-lg border-2 border-orange-500/80 bg-black px-4 py-3"
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg, rgba(0,0,0,0) 0 14px, rgba(234,88,12,0.12) 14px 28px)',
      }}
    >
      <div className="space-y-1.5">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-orange-400">
          <span aria-hidden>▲</span>
          Deposits take ~2 hours
          <span aria-hidden>▲</span>
        </p>
        <p className="text-xs text-orange-100/90 leading-relaxed">
          Sending (BOB) in?
        </p>
        <p className="text-xs text-orange-100/90 leading-relaxed">
          Your wBOB will mint on Gnosis after{' '}
          <span className="font-semibold text-orange-200">
            60 confirmations on the Dobbscoin side
          </span>
          {' '}— roughly <span className="font-semibold text-orange-200">2 hours</span>{' '}
          at 2-minute blocks. This is not a bug; it is the 51%-attack defence.
          (BOB) is a low-hash scrypt chain, and a couple hours of confirmations
          keep a freshly-minted wBOB from being reorged out from under itself
          when rented hashpower shows up.
        </p>
        <p className="text-xs text-orange-100/70 leading-relaxed">
          Withdrawals out (wBOB → (BOB)) are unaffected — those settle in about
          a minute on the Gnosis side and pay out as soon as the watcher signs
          off. Praise &quot;Bob.&quot;
        </p>
      </div>
    </div>
  );
}

// Compact inline note for placement next to the "Get my deposit address"
// button — short reminder, links the user mentally to the banner above.
export function InboundConfirmationInline() {
  return (
    <p className="rounded-md border border-orange-700/50 bg-orange-950/30 px-3 py-2 text-[11px] leading-relaxed text-orange-200/90">
      <span className="font-semibold uppercase tracking-wider text-orange-300">
        Heads up:
      </span>{' '}
      wBOB mints after <span className="font-semibold">60 (BOB) confirmations
      (~2 hours)</span>. This is 51%-attack hardening for a low-hash scrypt
      chain, not a stuck bridge. Withdrawals out are unaffected.
    </p>
  );
}

// Reassurance for the Withdraw page — explains that the inbound wait does
// NOT apply to wBOB → (BOB) releases.
export function OutboundConfirmationNote() {
  return (
    <p className="rounded-md border border-bob-700/40 bg-bob-500/5 px-3 py-2 text-[11px] leading-relaxed text-gray-300">
      <span className="font-semibold uppercase tracking-wider text-bob-300">
        Note:
      </span>{' '}
      Withdrawals settle quickly — the bridge waits only a handful of Gnosis
      blocks (~1 min) before queuing the (BOB) payout. The ~2-hour deep-conf
      wait is on <span className="italic">inbound</span> deposits only, where
      a low-hash scrypt chain needs to be defended against rented-hash reorgs.
    </p>
  );
}
