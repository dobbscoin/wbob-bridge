# wBOB Bridge

> *Backed By Nothing, Powered By Everything.*

A 1:1 lock-and-mint bridge between **Dobbscoin (BOB)** — the official
cryptocurrency of the Church of the SubGenius, scrypt-PoW since January
2014 — and **Wrapped Dobbscoin (wBOB)** on Gnosis Chain.

When (BOB) is locked on the Dobbscoin L1, wBOB is minted on Gnosis at an
8-decimal 1:1 ratio. When wBOB is burned on Gnosis, native (BOB) is
released back to a Dobbscoin address. The book balances. "Bob" is
satisfied. Slack increases.

**Live bridge:** https://bridge.subgenius.finance/
**Whitepaper:** [`docs/whitepaper.md`](./docs/whitepaper.md)

---

## What this repo is

A monorepo for the bridge. Each subdirectory is its own service:

```
contracts/   Foundry — WBob ERC-20 + BridgeController        (separate repo: dobbscoin/wbob-contracts)
backend/     TypeScript — Bridge API, FSM, Postgres, payouts
watcher/     TypeScript — Dobbscoin chain observer (3 instances, 3-of-5)
portal/      Next.js — user-facing deposit / trade / withdraw UI
shared/      TypeScript — shared types (FSM states, MintAuthorization, etc.)
infra/       Docker Compose, systemd units, nginx vhosts
ops/         Tokenlist submissions, logos, deployment notes
docs/        Whitepaper
```

---

## Trust model — Tier B, "Don't Trust, Verify, but Also Pray"

The bridge is **not trust-minimized**. It is **trust-halved**. Specifically:

- **3-of-5 threshold mints.** Five independent watcher EOAs observe the
  Dobbscoin chain. After a deposit reaches finality (6 confirmations on
  Dobbscoin, ~12 minutes), each watcher signs an EIP-712 typed
  `MintAuthorization`. When 3 of 5 signatures accumulate, **anyone** can
  call `executeMint()` and the wBOB is minted. No watcher can mint alone.
  No watcher can stop a mint that has 3 signatures.
- **Gnosis Safe admin.** `DEFAULT_ADMIN_ROLE` on the contracts is held by
  a Safe. Pause, role changes, signer rotation all require Safe-quorum
  approval. **No hot wallet ever holds admin.**
- **Constrained automation module.** A Safe module
  (`BridgeExecutorModule`) permits the automated executor to call only:
  `executeMint`, `pause`, `unpause`. It cannot rotate keys, change
  thresholds, or move admin. Even the bridge's own automation is on a
  short leash.
- **Replay protection.** `processedDeposits[depositId]` is set on first
  mint and **never cleared**. Even if every signer key were compromised,
  past deposits cannot be replayed.

In SubGenius register: the Conspiracy assumes you'll trust them. (BOB)
assumes you won't. wBOB splits the difference — trust 3 strangers out
of 5, supervised by a Safe, watched by an immutable contract.

**Audit status:** unaudited. Foundry test suite passes (unit + 1000-run
fuzz + invariant runs at depth 100). Third-party audit is a planned
follow-up. **NOT FINANCIAL ADVISORS. NOT FINANCIAL ADVICE.**

---

## Deployed contracts (Gnosis Chain, chainId 100)

| Contract | Address |
|---|---|
| wBOB ERC-20 | [`0x13550ae65f22A36f60A50d625B70b58666488263`](https://gnosisscan.io/address/0x13550ae65f22A36f60A50d625B70b58666488263) |
| BridgeController | [`0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872`](https://gnosisscan.io/address/0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872) |
| BridgeExecutorModule | [`0xd5ebf9EC7971B18A6b1e7f05Ee0BF96BE72e3410`](https://gnosisscan.io/address/0xd5ebf9EC7971B18A6b1e7f05Ee0BF96BE72e3410) |

Source code for the contracts lives in its own repo:
[`dobbscoin/wbob-contracts`](https://github.com/dobbscoin/wbob-contracts).

---

## Trading wBOB

| Venue | URL |
|---|---|
| CoW Swap (Gnosis) | https://swap.cow.fi/#/100/swap/wBOB/WXDAI |
| Oku Trade (Gnosis) | https://oku.trade/swap?inputChain=gnosis |

Quote currency is **WXDAI** (Wrapped xDai, USD-pegged stablecoin on
Gnosis). Because wBOB is 1:1 redeemable for native (BOB) through the
bridge, the WXDAI/wBOB pair is the canonical USD-equivalent price
reference for (BOB) itself.

(BOB) is **not for sale.** It is for trade. Don't say "buy" — say
"trade for". Don't say "sell" — say "trade away".

---

## Quickstart — running the stack locally

Each service has its own README with full env-var docs. The 60-second tour:

```bash
# 1. Bring up Postgres + the watcher Dobbscoin node (Docker)
cd infra && docker compose up -d

# 2. Backend API (port 13013 — yes, it spells BOB)
cd backend && npm install && npm run migrate && npm run dev

# 3. Watcher (one instance per signer — prod runs 3 on independent hosts)
cd watcher && npm install && npm run dev

# 4. Portal (Next.js, port 3000)
cd portal && npm install && npm run dev
```

For the contract suite, see
[`dobbscoin/wbob-contracts`](https://github.com/dobbscoin/wbob-contracts).

---

## The underlying chain — Dobbscoin (BOB)

(BOB) is a Bitcoin Core 0.10 fork from January 2014. Genesis was struck
on Coingen.io, the parameter-form altcoin generator opened that month
by Matt "BlueMatt" Corallo. The fork shipped scrypt PoW, P2PKH/P2SH
addresses, and a stock halving curve — all the chain-specific consensus
modifications (Kimoto Gravity Well at block 13,579, DigiShield at
31,597, 2-minute target at 68,425, flat 1.5-(BOB)/block forever cap at
951,753) were added later by community devs.

| Property | Value |
|---|---|
| PoW | scrypt |
| Block target | 2 minutes (since block 68,425) |
| Difficulty retarget | KGW + DigiShield hybrid, every block |
| Subsidy | 1.5 (BOB) / block forever (since block 951,753) — mildly inflationary by design |
| Max supply | **No hard cap.** A `MAX_MONEY` sanity ceiling of 10B exists, but is not a circulating-supply cap. The "21M cap" is a marketing line from 2014 that has never been true since the flat-subsidy transition. |
| Genesis | January 2014 |

Source: [`SubGeniusFinance/dobbscoin-source`](https://github.com/SubGeniusFinance/dobbscoin-source).
Live chain stats: https://explorer.dobbscoin.info/ext/getsummary

---

## Resources

| | |
|---|---|
| Project home | https://dobbscoin.info/ |
| Bridge UI | https://bridge.subgenius.finance/ |
| Block explorer | https://explorer.dobbscoin.info/ |
| Mining pool | https://pool.dobbscoin.info/ |
| Faucet | https://dobbscoin.info/faucet |
| "Bob" Bank (custodial web wallet) | https://subgenius.finance/bobbank |
| Android wallet APK | https://subgenius.vip/dobbscoin.apk |

### Community

- **X (Twitter):** [@Dobbscoin](https://x.com/Dobbscoin)
- **Telegram:** [SubGenius.Finance](https://t.me/+_alqp0yLOIs1ZmMx)
- **Discord:** [discord.gg/xbeeAwp3Z5](https://discord.gg/xbeeAwp3Z5)
- **Reddit:** [r/Dobbscoin](https://reddit.com/r/Dobbscoin)
- **Bitcointalk ANN (2014):** https://bitcointalk.org/index.php?topic=792459.0

---

## Disclaimers

This bridge is **unaudited** as of this writing. The contracts have a
thorough Foundry test suite, but no third-party security audit has been
completed yet. Trade accordingly.

The Church of the SubGenius is a parody religion. (BOB) is a
cryptocurrency that has been continuously operating since 2014. The
distinction matters in some legal jurisdictions and not at all in
others. Consult your shaman, accountant, and/or "Bob" before
participating.

**NOT FINANCIAL ADVISORS. NOT FINANCIAL ADVICE.**

> *"Eternal salvation, or triple your money back."* — original (BOB) ANN, 2014

— Praise "Bob".
