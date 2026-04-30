# CoinGecko submission — wBOB (Gnosis chain)

**Submit alongside `coingecko-bob-l1-submission.md`** — wBOB and BOB L1
should be linked as wrapped/underlying. Submit BOB first if possible,
then wBOB and reference BOB's CoinGecko ID; otherwise submit
simultaneously and ask the reviewer to cross-link them.

Form: https://www.coingecko.com/request-form?locale=en
(The old `/en/coins/new` URL is gone as of 2026; everything funnels through
the unified request form, which branches into coin / token / exchange flows.
For listing context see https://support.coingecko.com/hc/en-us/sections/32146983631641-Token-Coin-Listing
— note the **Fast Pass** (24h review) vs **Regular Pass** (≤ 5 days) option.)

## Fields

| Field | Value |
|---|---|
| Name | Wrapped Dobbscoin |
| Symbol | wBOB |
| Token type | ERC-20 (wrapped) |
| Decimals | 8 |
| Contract address | `0x13550ae65f22A36f60A50d625B70b58666488263` |
| Network / Chain | Gnosis (xDai) — chainId 100 |
| Block explorer | https://gnosisscan.io/address/0x13550ae65f22A36f60A50d625B70b58666488263 |
| Source-verified? | Yes — verified on Gnosisscan 2026-04-29 |
| Logo | https://raw.githubusercontent.com/1Hive/default-token-list/master/src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/logo.png |
| Website | https://bridge.subgenius.finance |
| Project homepage | https://dobbscoin.info |
| Source (bridge) | https://github.com/dobbscoin/wbob-bridge |
| Source (contracts) | https://github.com/dobbscoin/wbob-contracts |
| Underlying asset (CoinGecko ID) | `dobbscoin` (or whatever the BOB L1 ID becomes — see paired submission) |
| Wrapped/peg ratio | 1:1 with native BOB, backed by escrow on the Dobbscoin chain |

## Description (paste verbatim)

> wBOB is the Gnosis-chain ERC-20 representation of Dobbscoin (BOB), an
> independent scrypt-PoW chain forked from Bitcoin Core 0.10 in January
> 2014 (the official cryptocurrency of the Church of the SubGenius).
> Backed 1:1 by native BOB locked in a 3-of-5 threshold-signed bridge
> between the Dobbscoin L1 and Gnosis Chain. Brings Dobbscoin liquidity
> into Gnosis DeFi (CoW Swap, Oku) while preserving custody of the
> underlying.

## Markets / liquidity

Active trading venues on Gnosis:

- **CoW Swap** (default direction wBOB → WXDAI):
  https://swap.cow.fi/#/100/swap/wBOB/WXDAI
- **Oku** (default direction WXDAI → wBOB):
  https://oku.trade/swap?inputChain=gnosis&inToken=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d&outToken=0x13550ae65f22A36f60A50d625B70b58666488263

Quote currency: **WXDAI** (Wrapped xDai, USD-pegged stablecoin on Gnosis,
contract `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d`). This pair is the
canonical price-discovery venue for both wBOB and (by 1:1 bridge backing)
BOB itself.

## Social / community fields

- Twitter / X: https://x.com/Dobbscoin
- Telegram: https://t.me/+_alqp0yLOIs1ZmMx (SubGenius.Finance)
- Discord: https://discord.gg/xbeeAwp3Z5
- Reddit: https://reddit.com/r/Dobbscoin
- Bitcointalk ANN (2014): https://bitcointalk.org/index.php?topic=792459.0
- Whitepaper: https://github.com/dobbscoin/wbob-bridge/blob/master/docs/whitepaper.md

## Notes for the reviewer (paste in any "additional context" field)

- Bridge contracts source-verified on Gnosisscan as of 2026-04-29:
  - wBOB ERC-20: `0x13550ae65f22A36f60A50d625B70b58666488263`
  - BridgeController: `0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872`
  - BridgeExecutorModule: `0xd5ebf9EC7971B18A6b1e7f05Ee0BF96BE72e3410`
- Bridge has been smoke-tested end-to-end on Gnosis mainnet — inbound
  (BOB → wBOB mint) and outbound (wBOB burn → BOB payout) both confirmed.
- Trust model: 3-of-5 threshold-signed mints (independent watcher EOAs);
  admin role held by a Gnosis Safe; no hot wallet ever holds
  `DEFAULT_ADMIN_ROLE`.
- Contracts have a thorough Foundry test suite (unit + 1000-run fuzz +
  invariant runs at depth 100); third-party security audit is a planned
  follow-up — not yet completed. Treat the trust model accordingly.
- The underlying Dobbscoin L1 chain has been continuously operating since
  its January 2014 genesis. Live chain stats (supply, hashrate, height)
  are publicly readable at https://explorer.dobbscoin.info/ext/getsummary
- Please cross-reference this entry as the wrapped variant of the
  paired BOB L1 submission.
