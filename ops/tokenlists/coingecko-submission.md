# CoinGecko submission — wBOB

Form: https://www.coingecko.com/en/coins/new

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
| Logo | https://dobbscoin.info/images/wBOB.png |
| Website | https://bridge.subgenius.finance |
| Project homepage | https://dobbscoin.info |
| Source (bridge) | https://github.com/dobbscoin/wbob-bridge |
| Source (contracts) | https://github.com/dobbscoin/wbob-contracts |

## Description (paste verbatim)

> wBOB is the Gnosis-chain ERC-20 representation of Dobbscoin (BOB), the
> official cryptocurrency of the Church of the SubGenius. Backed 1:1 by
> BOB locked in a 3-of-5 threshold-signed bridge between the Dobbscoin L1
> and Gnosis Chain. Brings BOB liquidity into Gnosis DeFi (CoW Swap,
> Balancer, Honeyswap) while preserving custody of the underlying.

## Markets / liquidity (Balancer CoW AMM)

- Pair: **WXDAI / wBOB**
- Pool address: `0xefe75bf74018a5257a73f31b434ab91a20f57847`
- URL: https://balancer.fi/pools/gnosis/cow/0xefe75bf74018a5257a73f31b434ab91a20f57847

## You-fill-this fields (CoinGecko nearly always asks)

- [ ] Twitter / X handle
- [ ] Telegram group
- [ ] Discord invite
- [ ] Reddit (r/SubGenius? r/Dobbscoin?)
- [ ] Parent CoinGecko ID — search `coingecko.com` for "dobbscoin". If BOB is already listed, link wBOB as a wrapped variant.
- [ ] Whitepaper URL (or use `github.com/dobbscoin/wbob-bridge/blob/master/CLAUDE.md` as the architecture reference if no formal whitepaper exists)

## Notes for the reviewer (paste in any "additional context" field)

- Bridge has been smoke-tested end-to-end on Gnosis mainnet — inbound mint
  and outbound burn/payout both confirmed.
- Independent contract review is in progress; the architecture is the
  standard threshold-signed lock/mint pattern with a Gnosis Safe holding
  admin (`DEFAULT_ADMIN_ROLE`) and a Safe module (`BridgeExecutorModule`)
  gating automated mint calls.
- Pool is a Balancer CoW AMM (not vanilla Balancer Vault), so it's
  tradeable via CoW Swap once solvers index the token.
