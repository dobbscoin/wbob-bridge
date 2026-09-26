// The /trade page notice (btcbob, 2026-09-26): (BOB) is worthless on purpose,
// SubGenius.Finance is not the market, provides no liquidity, fronts nothing,
// and is not responsible for prices or for anyone's own decisions.
const CLAUSES: { title: string; body: string }[] = [
  {
    title: "(BOB) is worthless on purpose.",
    body: "(BOB) and wBOB are Monetized Slack: a joke with a working blockchain behind it. They are not an investment, not a security, not a store of value, and not a promise of anything. DO NOT INVEST. Do not buy (BOB) or wBOB expecting it to go up. It may go to zero. It may already be there.",
  },
  {
    title: "We are not the market.",
    body: "Trades on this page are carried out by third-party decentralized exchanges (CoW Swap, Oku, and the pools they route through). SubGenius.Finance, the (BOB) developers and the Church of the SubGenius are not affiliated with those protocols, their operators, or any liquidity pool or liquidity provider, and have no control over prices, fees, routing, slippage or execution.",
  },
  {
    title: "We do not provide the liquidity.",
    body: "Nobody here supplies, props up, manages or guarantees liquidity for wBOB. Nobody here fronts (BOB) or wBOB to promoters, shillers, influencers, market makers or anyone else. If someone tells you otherwise, they are selling you something, and it isn't us.",
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
