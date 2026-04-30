# CoinMarketCap submission — wBOB

Form: https://coinmarketcap.com/request/

CMC's submission flow is more rigid than CoinGecko's — they have separate
forms for "new asset" and "new exchange" and they enforce stricter
liquidity / volume / verification gates. Plan to need:

- An active trading pair on a CMC-supported venue with **real volume**
  (CoW Swap is supported; verify Oku is supported before relying on it)
- Source-verified contract on Gnosisscan (✓ — done 2026-04-29)
- Active social presence (X, Telegram, Discord, etc.)
- Logo: 200×200 PNG with transparent background (different size from
  CoinGecko/1Hive's 256×256 — convert before submission)
- Whitepaper or technical doc URL

## Fields

| Field | Value |
|---|---|
| Project name | Wrapped Dobbscoin |
| Symbol | wBOB |
| Project category | Wrapped tokens / Bridge tokens |
| Token type | ERC-20 |
| Decimals | 8 |
| Contract address | `0x13550ae65f22A36f60A50d625B70b58666488263` |
| Platform / chain | Gnosis Chain (chainId 100) |
| Block explorer | https://gnosisscan.io/address/0x13550ae65f22A36f60A50d625B70b58666488263 |
| Source-verified? | Yes — verified 2026-04-29 |
| Project website | https://dobbscoin.info |
| Bridge UI | https://bridge.subgenius.finance |
| Logo (200×200 PNG) | TBD — resize from 256×256 source at `ops/tokenlists/logo/wBOB.png` |
| Tags | bridge, gnosis-chain, wrapped-tokens, scrypt, community-token |

## Project description (paste verbatim — keep under 500 chars for CMC's short field)

> wBOB is the Gnosis-chain ERC-20 representation of Dobbscoin (BOB), an
> independent scrypt-PoW chain forked from Bitcoin Core 0.10 in January
> 2014 and the official cryptocurrency of the Church of the SubGenius.
> Backed 1:1 by BOB locked in a 3-of-5 threshold-signed bridge. Brings
> Dobbscoin liquidity into Gnosis DeFi.

## Long description (for CMC's "About" / detailed-description field)

> Dobbscoin (ticker BOB) is a Bitcoin Core 0.10 fork from January 2014,
> using scrypt proof-of-work with a 2-minute target block time and a
> flat 1.5 BOB per-block subsidy (subsidy halvings ran on the standard
> Bitcoin schedule until block 951,752, then the chain transitioned to
> a permanent flat subsidy — making it mildly inflationary by design).
>
> Difficulty retargeting uses a hybrid algorithm: Kimoto Gravity Well
> from block 13,579, then DigiShield from block 31,597, then DigiShield
> with the 2-minute target from block 68,425. Tx version 1 only —
> the chain stayed pre-BIP68/CSV.
>
> wBOB is the Gnosis-chain wrapped representation, minted via a
> threshold-signed lock/mint bridge: 3-of-5 independent watchers must
> sign each MintAuthorization (EIP-712), with the admin role held by
> a Gnosis Safe. Burning wBOB on Gnosis triggers a corresponding payout
> of native BOB on the Dobbscoin chain.
>
> The Dobbscoin chain has been continuously operating since its 2014
> genesis. Live chain stats: https://explorer.dobbscoin.info/

## Markets / liquidity

(Verify Oku as a CMC-recognized exchange before relying on it; if not,
fall back to CoW Swap as the primary cited venue.)

- **CoW Swap** (Gnosis):
  https://swap.cow.fi/#/100/swap/wBOB/WXDAI
- **Oku** (Gnosis):
  https://oku.trade/swap?inputChain=gnosis&inToken=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d&outToken=0x13550ae65f22A36f60A50d625B70b58666488263

## Social / community

- [ ] X / Twitter handle
- [ ] Telegram group
- [ ] Discord invite (existing SubGenius / Dobbscoin server)
- [ ] Reddit — r/SubGenius (community), r/Dobbscoin (token-specific if it exists)
- [ ] GitHub: https://github.com/dobbscoin (org)
- [ ] Bitcointalk thread: TBD (link if there's a current ANN)

## "Parent" coin link

If Dobbscoin (BOB) is already listed on CMC as the L1 coin, request that
wBOB be linked as the wrapped variant (CMC supports this association on
the asset detail page). If BOB is NOT yet on CMC, consider submitting BOB
first and wBOB second — the wrapped-variant relationship is cleaner that
way.

Search: https://coinmarketcap.com/?query=dobbscoin

## Notes for the reviewer (additional-context field)

- The Dobbscoin L1 chain is publicly explorable at
  https://explorer.dobbscoin.info — block height, supply, hash rate, and
  difficulty are all live-readable.
- Bridge contracts source-verified on Gnosisscan as of 2026-04-29 (wBOB
  ERC-20, BridgeController, BridgeExecutorModule).
- Bridge has been smoke-tested end-to-end on Gnosis mainnet — inbound
  (BOB → wBOB mint) and outbound (wBOB burn → BOB payout) both confirmed.
- Trust model: 3-of-5 threshold-signed mints; admin role in a Gnosis
  Safe; no hot wallet ever holds DEFAULT_ADMIN_ROLE.
- Contracts have a thorough Foundry test suite (unit + fuzz + invariant);
  third-party security audit is a planned follow-up, not yet completed.
- Dobbscoin's history is part of Coingen-era altcoin generation
  (BlueMatt's Coingen.io, January 2014) — this provides reasonable
  origin documentation for the asset's pedigree.

## Pre-submission checklist

- [ ] Resize logo to 200×200 PNG and save to
      `ops/tokenlists/logo/wBOB-200.png`
- [ ] Confirm Oku is a CMC-recognized exchange
      (check `coinmarketcap.com/exchanges/`); if not, lead with CoW Swap only
- [ ] Verify a Telegram and/or Discord invite link is current and joinable
- [ ] Verify all GitHub repo links are public and accessible
- [ ] Submit BOB first (if not already listed), then wBOB as wrapped variant
- [ ] After submission: monitor CMC's email for clarification requests;
      they often ask for trading-volume proof
