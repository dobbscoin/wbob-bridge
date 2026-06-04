# Tokenlist submissions for wBOB

Once wBOB is in the right tokenlists, CoW Swap, Honeyswap, Swapr, and most
Gnosis aggregators will recognize the token automatically — fixing the
"NoLiquidity / route not found" symptoms when trying to swap against the
WXDAI/wBOB CoW AMM pool.

## Target: 1Hive/default-token-list (Honeyswap default — high leverage)

This is the most-used tokenlist on Gnosis Chain. Many other tools ingest it
downstream, so getting in here propagates broadly. Files to touch:

- `src/tokens/gnosis.json`  → add one new entry to the array
- `src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/logo.png`
  → 256×256 PNG of the wBOB logo

The entry to add is in `wbob.gnosis.entry.json` next to this README:
```json
{
  "name": "Wrapped Dobbscoin on Gnosis",
  "address": "0x13550ae65f22a36f60a50d625b70b58666488263",
  "symbol": "wBOB",
  "decimals": 8,
  "chainId": 100,
  "logoURI": "https://raw.githubusercontent.com/1Hive/default-token-list/master/src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/logo.png"
}
```

### Step-by-step PR

```bash
# 1. Fork on github.com via the web UI:  github.com/1Hive/default-token-list
#    Fork to your own account (e.g. dobbscoin/default-token-list)

# 2. Clone your fork
git clone git@github.com:dobbscoin/default-token-list.git
cd default-token-list

# 3. Add the entry — open src/tokens/gnosis.json in an editor and insert the
#    object from wbob.gnosis.entry.json into the alphabetical position by
#    `name` (their convention). Keep JSON valid (commas in the right spots).

# 4. Add the logo PNG. 256×256 transparent or solid background.
mkdir -p src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263
cp /path/to/your/wbob-logo.png \
   src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/logo.png

# 5. Verify it builds + lints
npm install
npm test

# 6. Commit using their conventional-commit format
git add src/tokens/gnosis.json src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/
git commit -m "feat(add): Wrapped Dobbscoin (wBOB)"
git push origin master

# 7. Open the PR via github.com/SubGeniusFinance/default-token-list and click
#    "Compare & pull request". Title:  "feat(add): Wrapped Dobbscoin (wBOB)"
#
#    Body suggestion:
#      Adds wBOB, the Gnosis-side token of the Dobbscoin → Gnosis bridge.
#      Bridge contracts: github.com/dobbscoin/wbob-contracts
#      Bridge UI:        https://bridge.subgenius.finance
#      CoW AMM pool:     https://balancer.fi/pools/gnosis/cow/0xefe75bf74018a5257a73f31b434ab91a20f57847
```

### About the logo

If you don't have a wBOB logo yet, options:
- Reuse the Dobbscoin logo (just call it wBOB) — fastest
- Generate a placeholder: dark circle, "wBOB" text in white, 256×256
- Have a designer make a proper one with the "w" prefix overlaid on the BOB icon

Maintainers may bounce a PR for a low-quality logo; better to wait a day for
a proper PNG than rush a placeholder.

## Other tokenlists worth submitting to (lower priority, easier wins)

- **CoinGecko**: free, takes 24-48h. Once listed, gives CoW solvers an
  external price feed which improves routing reliability.
  Submission form: https://coingecko.com/en/coins/new

- **CoinMarketCap**: similar, gives broader exchange-aggregator coverage.

- **CoW Swap's curated list**: lower priority — they re-export
  CoinGecko + 1Hive lists, so getting into those covers CoW.

## Why this fixes the trade-routing problem

CoW solvers gate which tokens they'll route through. A token that's:
- not in any major tokenlist
- has no external price source (CoinGecko, etc.)
- has only one venue (your $2k CoW AMM pool)

…is treated as "I don't know what this is worth, refusing to quote." Once
wBOB is in 1Hive's list (and ideally CoinGecko too), the same `NoLiquidity`
quote will return a real number.
