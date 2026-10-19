// The /trade page notice (btcbob, 2026-09-26; liquidity clauses corrected
// 2026-10-19): (BOB) is worthless on purpose. SubGenius.Finance does not run the
// exchanges but IS the only wBOB liquidity provider (unlocked, at-risk money,
// 1% pool fee to us), fronts nothing, and is not responsible for prices or for
// anyone's own decisions.
const CLAUSES: { title: string; body: string }[] = [
  {
    title: "(BOB) is worthless on purpose.",
    body: "(BOB) and wBOB are Monetized Slack: a joke with a working blockchain behind it. They are not an investment, not a security, not a store of value, and not a promise of anything. DO NOT INVEST. Do not buy (BOB) or wBOB expecting it to go up. It may go to zero. It may already be there.",
  },
  {
    title: "We are not the exchange.",
    body: "CoW Swap and Oku are third-party apps. We don't run them and have no say over their routing, fees, slippage or execution. They trade against pools on Gnosis, and the wBOB pools are ours (see 3).",
  },
  {
    title: "We are the liquidity.",
    body: "Every wBOB pool on Gnosis was seeded by us from the treasury wallet subgeniusfinance.eth: as much wBOB as we cared to part with, paired against whatever real money we could wrangle, at a price so low it's hard to take seriously. The 1% pool fee on every trade comes to us. None of it is locked, and locking it would prove nothing: it would only lock up the real money. wBOB could be torpedoed tomorrow and the (BOB) would still be here. The plan is to swap our own at-risk stake out for 4-year locked liquidity as NFT sales and other projects pay for it. None of that is a promise to hold the price anywhere. Nobody here fronts (BOB) or wBOB to promoters, shillers, influencers or market makers. If someone tells you otherwise, they are selling you something, and it isn't us.",
  },
  {
    title: "Prices move. That is your problem.",
    body: "wBOB's price can rise, fall, vanish, or all three before lunch. SubGenius.Finance accepts no responsibility for price swings, slippage, impermanent loss, failed transactions, gas spent, misconfigured wallets, lost keys, tokens sent to the wrong address, or decisions made while excited.",
  },
  {
    title: "You are responsible for you.",
    // TODO: once /reserves is live, end with ", with its reserves shown on /reserves."
    body: "By using this page you agree that you understand what a token swap is, that you act on your own judgment, and that any loss is yours alone, including loss from your own ignorance, haste, greed, or failure to read this notice. The bridge does one thing: it wraps (BOB) as wBOB and back again, 1:1.",
  },
  {
    title: "No advice.",
    body: "Nothing on this site is financial, investment, legal or tax advice. NOT FINANCIAL ADVISORS. NOT FINANCIAL ADVICE. If you need advice, pay a professional. If you need Slack, praise \"Bob\".",
  },
  {
    title: "Where you are is your business.",
    body: "Check whether using this page is legal where you live. If it isn't, don't.",
  },
];

export function TradeNotice() {
  return (
    <section
      aria-labelledby="trade-notice-title"
      className="rounded-lg border border-yellow-900/50 bg-yellow-950/20 px-5 py-4 text-yellow-100/80"
    >
      <h2 id="trade-notice-title" className="text-sm font-bold uppercase tracking-wider text-yellow-300">
        Notice of Worthlessness, Disaffiliation and General Non-Liability
      </h2>
      <p className="mt-1 text-xs italic text-yellow-200/60">
        Required by The Conspiracy. Read all of it. &ldquo;Bob&rdquo; is watching.
      </p>
      <ol className="mt-3 space-y-2 text-xs leading-relaxed">
        {CLAUSES.map((c, i) => (
          <li key={i}>
            <span className="font-semibold text-yellow-200">{i + 1}. {c.title}</span>{" "}
            {c.body}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-yellow-200/70">
        <em>No refunds, no rebates, no rapture insurance.</em>{" "}
        <strong className="text-yellow-300">Praise &ldquo;Bob&rdquo;.</strong>
      </p>
    </section>
  );
}
