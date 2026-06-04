# CoinGecko submission — Dobbscoin (BOB) — Layer 1 native coin

**Submit alongside `coingecko-submission.md` (wBOB on Gnosis)** — BOB
and wBOB should be linked as underlying/wrapped. If CoinGecko's flow
allows, submit BOB first (this entry), then wBOB referencing BOB's
CoinGecko ID; otherwise submit simultaneously and ask the reviewer to
cross-link.

Form: https://www.coingecko.com/request-form?locale=en
(The old `/en/coins/new` URL is gone as of 2026; everything funnels through
the unified request form, which branches into coin / token / exchange flows.
For listing context see https://support.coingecko.com/hc/en-us/sections/32146983631641-Token-Coin-Listing
— note the **Fast Pass** (24h review) vs **Regular Pass** (≤ 5 days) option.)

(BOB is a native chain coin, NOT an ERC-20 — when the form asks, select
the "native cryptocurrency" / "new coin" path, not the contract-address
path. The wBOB submission uses the contract-address path.)

## Fields

| Field | Value |
|---|---|
| Name | Dobbscoin |
| Symbol | BOB |
| Type | Native cryptocurrency (independent chain) |
| Genesis | January 2014 |
| Consensus | Scrypt proof-of-work |
| Block target | 2 minutes (since block 68,425) |
| Subsidy | Flat 1.5 BOB per block forever (since block 951,753) — mildly inflationary by design |
| Max supply | **No hard cap** (a `MAX_MONEY` sanity ceiling exists at 10,000,000,000 BOB but is not a circulating-supply cap) |
| Block explorer | https://explorer.dobbscoin.info/ |
| Explorer JSON API | https://explorer.dobbscoin.info/ext/getsummary (returns blockcount, difficulty, hashrate, supply, connections) |
| Source repo | https://github.com/SubGeniusFinance/dobbscoin-source |
| Project homepage | https://dobbscoin.info |
| Logo | Canonical BOB layer-1 logo (gold coin with "Bob" Dobbs face + binary border) — local copy: `ops/tokenlists/logo/BOB-512.png` (512×512 RGBA, 235 KB). Source-of-truth: `androidbob/market/market-app-icon.png` (the Google Play store icon for the official BOB Android wallet). For submissions that want smaller resolution, also available at `ops/tokenlists/logo/BOB-256.png`. **NOTE:** this is a different image from the wBOB submission's logo — that one has a "w"-prefix variant; this one is the original (BOB) coin face. |
| Wrapped variant (CoinGecko ID) | The paired wBOB-on-Gnosis submission |

## Description (paste verbatim)

> Dobbscoin (BOB) is an independent scrypt proof-of-work chain forked
> from Bitcoin Core 0.10 in January 2014 — the official cryptocurrency
> of the Church of the SubGenius parody religion. The chain has been
> continuously operating since genesis. Block target is 2 minutes;
> subsidy is a flat 1.5 BOB per block forever (the Bitcoin-style halving
> schedule was capped at block 951,752 and then transitioned to a
> permanent flat subsidy, making BOB mildly inflationary by design —
> there is no hard supply cap). Difficulty retargets every block via a
> hybrid Kimoto Gravity Well + DigiShield algorithm. Tradeable on
> Gnosis Chain via the wBOB wrapped variant (separate CoinGecko entry).

## Long description (for the "About" / detailed section)

> **Origin.** Dobbscoin was minted in January 2014 via Coingen.io,
> the paid altcoin generator opened that same month by Matt
> "BlueMatt" Corallo. Coingen forked Bitcoin Core 0.10 from a parameter
> form (name, ticker, scrypt-vs-SHA256, block target, subsidy, halving
> interval) and shipped Linux + Windows binaries. The shape of the
> initial Dobbscoin source matches what Coingen stamped out: clean
> Bitcoin Core 0.10 fork, scrypt PoW, P2PKH/P2SH unchanged from
> upstream, transaction version 1 only, stock upstream halving curve.
> All chain-specific consensus modifications (KGW retarget at block
> 13,579, DigiShield at 31,597, 2-minute target at 68,425, flat-1.5
> subsidy cap at 951,753) were added later by community developers.
>
> **Consensus details.**
> - Block target: 2 minutes (since block 68,425; earlier history used
>   different targets per the diffmode timeline below)
> - Difficulty retarget: hybrid KGW + DigiShield, retargets every block
> - Subsidy: 1.5 BOB per block forever (flat) since block 951,753
> - Tx version: 1 only (chain stayed pre-BIP68/CSV — no relative
>   timelocks, no native Lightning support)
> - Address format: standard Bitcoin legacy P2PKH/P2SH (unchanged)
>
> **Diffmode timeline (`src/pow.cpp`):**
> - Blocks 0–13,578: V1 — Bitcoin-style 2016-block retarget
> - Blocks 13,579+: V2 — Kimoto Gravity Well ("BOB's Wormh0le")
> - Blocks 31,597+: V3 — DigiShield, 10-minute target
> - Blocks 68,425+: V4 — DigiShield, 2-minute target (current regime)
>
> **Inflation math.** 1.5 BOB per block × 30 blocks/hour = 45 BOB/hour
> ≈ 394,200 BOB/year. Time to reach `MAX_MONEY = 10B` ≈ 25,000 years.
> Practically uncapped.
>
> **Wrapped variant.** wBOB is the ERC-20 representation on Gnosis
> Chain, backed 1:1 by BOB locked in a 3-of-5 threshold-signed bridge.
> See the paired CoinGecko submission for wBOB.

## Markets / liquidity (price discovery)

BOB does not currently trade on any centralized exchange. Price
discovery happens on the Gnosis Chain via the wBOB wrapped variant,
which is backed 1:1 by escrowed BOB:

- **CoW Swap (Gnosis)** — wBOB → WXDAI:
  https://swap.cow.fi/#/100/swap/wBOB/WXDAI
- **Oku (Gnosis)** — WXDAI → wBOB:
  https://oku.trade/swap?inputChain=gnosis

Because wBOB is 1:1 redeemable for native BOB through the bridge at
https://bridge.subgenius.finance, the WXDAI/wBOB market on Gnosis is
also the canonical USD-equivalent price reference for native BOB.

## Social / community fields

- Twitter / X: https://x.com/Dobbscoin
- Telegram: https://t.me/+_alqp0yLOIs1ZmMx (SubGenius.Finance)
- Discord: https://discord.gg/xbeeAwp3Z5
- Reddit: https://reddit.com/r/Dobbscoin
- Bitcointalk ANN (2014): https://bitcointalk.org/index.php?topic=792459.0
- Whitepaper: https://github.com/dobbscoin/wbob-bridge/blob/master/docs/whitepaper.md

## Notes for the reviewer (additional-context field)

- The Dobbscoin chain has been operating continuously for over a
  decade. Live chain stats: supply ~8.1M BOB, hashrate ~135 MH/s,
  height ~1.83M, target 2 minutes — readable at
  https://explorer.dobbscoin.info/ext/getsummary
- Common false claim about Dobbscoin: "21,000,000 max supply." This is
  wrong — that figure was a marketing line from the 2014 ANN that has
  not been true since the flat-subsidy transition at block 951,753.
  The chain is mildly inflationary; no hard cap exists in source.
  See `src/main.cpp:1310-1316` and `src/amount.h:28` in the source
  repo for the consensus code.
- Common false claim: "10-minute blocks." Wrong — current target is
  2 minutes (since block 68,425). The 10*60 value visible in
  `chainparams.cpp:125` is the legacy V1 retarget value, overridden
  by DiffMode V4 in `pow.cpp:474-478`.
- Honest framing of Dobbscoin's pedigree: it's a Coingen-era altcoin
  (BlueMatt's lathe, January 2014). The CoinGen origin is verifiable
  via `super3/coingen` on GitHub (later steward + open-sourced code)
  and Wayback Machine snapshots of `coingen.io` from Jan-Feb 2014.
  Subsequent consensus changes (KGW, DigiShield, flat-subsidy) are
  community contributions on top, not part of the original Coingen
  template.
- Recommended actions for the reviewer:
  - Cross-link this entry as the underlying for the wBOB wrapped
    variant (paired submission).
  - Use the Gnosis WXDAI/wBOB market as the price feed for this
    asset, as native BOB has no CEX listings.
