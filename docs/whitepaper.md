# wBOB: A Trust-Halved Bridge for the Backed-by-Nothing-Powered-by-Everything Coin

**A Whitepaper of Quasi-Sober Engineering with a Slack-Adjacent Disposition**

*v0.2 — Recalibrated confirmation thresholds to match the deployed bridge. Submitted to the Conspiracy under protest, with "Bob"'s endorsement.*

---

## Abstract

We present **wBOB**, a 1:1 wrapped representation of Dobbscoin (BOB) on the
Gnosis Chain. Unlike the Pink-money systems of the Conspiracy, wBOB does not
pretend to be backed by an inflated "promise" or a "treasury." It is backed
by the only thing that has ever mattered: actual (BOB), locked in addresses
whose private keys are scattered across a 3-of-5 threshold of independent
SubGenius-aligned operators, none of whom can spend the funds alone. wBOB
mints when (BOB) is locked. wBOB burns when (BOB) is released. The book
balances. "Bob" is satisfied. Slack increases.

This document describes the cryptographic, operational, and theological
foundations of the bridge.

---

## 1. Motivation

Dobbscoin (BOB) is an ancient and stubborn coin: a Bitcoin Core fork from
the pre-BIP68 era, sized 8 satoshi-decimals like its progenitor, and
governed by precisely as much consensus as its miners can be bothered to
agree to. It is, in short, a coin that does not give a damn — a property
the Conspiracy has not yet figured out how to monetize. This makes (BOB) the
most spiritually qualified asset in cryptocurrency.

But (BOB) has a problem: it's stuck on a chain where no one builds. The
DeFi rituals of the modern age — liquidity pools, swaps, lending markets,
yield strategies — happen on EVM chains. (BOB) holders who wish to perform
these rites must either (a) sell their (BOB) for Conspiracy-money, which is
unthinkable, or (b) wrap it.

We chose (b).

We chose Gnosis Chain specifically because it is the EVM ecosystem most
likely to share (BOB)'s contempt for the Conspiracy's preferred currencies.
Gnosis runs on xDAI, a stablecoin pegged to the dollar but custodied
nowhere the SEC can subpoena. Its native gas costs are fractions of a
cent. Its tooling is mature. And its community has a working sense of
humor — a non-negotiable prerequisite for adopting wBOB.

---

## 2. The Trust Model: Tier B, or "Don't Trust, Verify, but Also Pray"

A bridge is only as strong as the weakest assumption that holds the
locked funds in place. wBOB's assumption is that **at least 3 of 5
independent watchers refuse to collude**. Specifically:

- Five EOAs are registered as authorized signers on the `BridgeController`
  contract on Gnosis. Each is operated independently. None has admin
  privileges over the bridge.
- An incoming (BOB) deposit is detected by all five watchers. Each watcher
  independently verifies that:
  1. The transaction lands on the Dobbscoin canonical chain
  2. It pays the correct amount to a watched address
  3. It has reached the finalization threshold (**60 confirmations, ~2 hours
     at 2-minute block spacing**)
  4. The deposit hasn't already been processed (replay prevention via
     a deterministic `depositId` derived from txid + vout + amount + recipient)
- Once finalized, each watcher signs an **EIP-712 typed `MintAuthorization`**
  — a structured data blob that includes the `depositId`, the recipient
  address, the amount, the source chain ID, and a deadline.
- When 3 of 5 signatures accumulate, **anyone** may submit them to
  `BridgeController.executeMint()`, which verifies the threshold, dedupes
  signers, marks the `depositId` as processed (forever, no clearing), and
  mints the corresponding wBOB.

### 2.1 Why 60 confirmations

(BOB) is a low-hash scrypt chain. Network hashrate hovers in the low
hundreds of MH/s — well within the rental envelope of a NiceHash-class
attacker. A bridge that minted wBOB after 6 confirmations could, in
principle, be drained: deposit (BOB), wait 12 minutes, mint wBOB, swap
wBOB for xDAI on Gnosis, then 51%-reorg the Dobbscoin chain to invalidate
the deposit before the watchers noticed. The bridge would still hold the
debt; the underlying (BOB) deposit would simply disappear from canonical
history.

Sixty confirmations (~2 hours) raises the rented-hashrate budget for that
attack by an order of magnitude — sustained 51%+ for two hours is a very
different shopping list than for twelve minutes. It is also forward-
compatible with the **v0.11.0 hard fork at block 1,888,808 (~2026-07-16)**,
which introduces a 100-block consensus cap on reorg depth (see
`dobbscoin-source/src/pow.h MAX_REORG_DEPTH`). Past that fork, a reorg
deeper than 60 blocks is not consensus-legal to begin with; 60-conf
finality straddles the cap with margin.

This is the trade we make explicit: **inbound deposits are slow on
purpose**. Outbound withdrawals are not (§3).

The contract requires no further authority for mint. There is no
sysadmin who can intervene mid-mint. There is no oracle that can declare
"the price has moved, please pause." The only privileged role —
`DEFAULT_ADMIN_ROLE` — is held by a Gnosis Safe whose owners are humans.
Even the automated executor that submits mint transactions runs through
a constrained Safe **module** (`BridgeExecutorModule`) that can only call
three functions: `executeMint`, `pause`, and `unpause`. Drain attempts
require a multi-signer ceremony performed in plain sight on-chain.

This is not a trustless bridge. We don't believe trustless bridges exist.
This is a *bridge that names its trust assumptions out loud and reduces
them as far as practical engineering allows*. Tier B in the taxonomy.
B for Bob, of course.

---

## 3. The Reverse Direction: Burning is Praying

Outbound is the fast direction. The asymmetry is the entire point of §2.1:
inbound has to defend against rented-hash reorgs, outbound does not —
because by the time the bridge pays out, the wBOB it represents has
already been burned on Gnosis and cannot be re-spent. A failed-payout
liability stays on the operator's books, not on the supply ledger.

To redeem wBOB for (BOB), the holder calls `requestWithdrawal(amount,
dobbscoinAddress)` on the BridgeController. The contract:

1. Burns the wBOB from the caller's balance immediately. There is no
   approval step, no allowance, no two-transaction dance. You pay your
   tithe and you walk away lighter.
2. Emits a `WithdrawalRequested` event containing the burn details and a
   monotonically-increasing per-user nonce.
3. The bridge backend, watching Gnosis for these events, waits **12
   Gnosis blocks (~1 minute)** for burn-tx finalization, then constructs
   a Dobbscoin transaction that pays the requested address from the
   bridge's hot-wallet UTXO pool. The hot wallet's keys are derived from
   a hierarchical deterministic seed that the bridge operator alone holds.
4. Once the Dobbscoin payout transaction reaches **3 confirmations
   (~6 minutes)**, the bridge marks the order `COMPLETED`, and Slack
   returns to its previous level.

End-to-end outbound latency is therefore on the order of **~7 minutes**
(1 min Gnosis finality + a few seconds for queue and broadcast + ~6 min
Dobbscoin payout confirmation). Compared to inbound's ~2-hour deep-conf
wait, this is the bridge's standing offer: *the door swings out faster
than it swings in*.

The bridge absorbs the Dobbscoin miner fee (~2,260 satoshis per
2-input/2-output payout). This is the bridge's tithe to the Dobbscoin
miners, who are themselves performing acts of devotion by hashing under
a proof-of-work algorithm whose only purpose is to slowly erode the
Conspiracy's electricity supply. We do not ask the user to pay this fee
because "Bob" provides.

---

## 4. Architecture: What's Actually Running

| Component | Role | Where |
|---|---|---|
| `WBob.sol` | ERC-20, 8 decimals, role-gated mint/burn | Gnosis Chain |
| `BridgeController.sol` | Threshold-sig mint authorization, withdrawal requests, daily-mint cap | Gnosis Chain |
| `BridgeExecutorModule.sol` | Safe module gating automated calls | Gnosis Chain |
| Watcher × 5 | Dobbscoin block scanner + EIP-712 signer | 5 independent operators |
| Backend | Gnosis event watcher, mint executor, payout executor, solvency monitor | Operator-run |
| Portal | Next.js + RainbowKit user interface | bridge.subgenius.finance |

Every component except the watchers can fail without the bridge being
unsafe. If the backend halts, mints stop until it recovers — but no
funds are at risk. If the portal goes down, users can interact with
the contracts directly via Etherscan. If a watcher goes offline, the
remaining four can still produce the 3-of-5 quorum. The bridge's
liveness depends on *some* infrastructure existing; its safety depends
on *no infrastructure being malicious enough to compromise 3 of 5
independent operators simultaneously*.

---

## 5. Tokenomics: We Refuse to Have Any

wBOB is not a separate asset class. It does not have its own emission
schedule. It does not have governance rights. It does not entitle holders
to anything other than the right to redeem it for the underlying (BOB). The
total supply of wBOB at any moment equals the sat-amount of (BOB) locked in
the bridge's deposit addresses, modulo the cumulative payout fees that
have leaked to Dobbscoin miners.

There is no premine. There is no team allocation. There is no "vesting."
If you hold wBOB, the only thing it represents is your claim on an equal
amount of (BOB) that is sitting on the Dobbscoin chain. We will not be
adding utility, governance, or NFT-staking-yield-farming-loyalty-program
features **to the wBOB token contract itself**. The whole point of wBOB
is that it's *exactly as stupid as the underlying coin, just on a
different chain*.

This minimalism is scoped to the wrapped-asset contract, deliberately:
the safest contract is the one with the fewest reasons to change.
Project-level coordination — community treasury, ecosystem grants,
liquidity-pool seeding, mutual-aid loss reimbursement — happens at a
separate sibling layer (see §7). That layer can be as opinionated as
its members make it. wBOB itself stays boring.

This is the only honest position. "Bob" approves.

---

## 6. Security Posture and Audit Status

The contracts have been subjected to:

- A unit-test suite covering the obvious invariants (replay prevention,
  signer dedup, threshold enforcement, role gating, mint-cap math)
- A 1000-run fuzz suite per state-changing function
- A 500-run × depth-100 invariant suite that exercises arbitrary call
  sequences and asserts the supply-vs-deposits balance never breaks

None of this is a substitute for a real audit. An independent contract
review remains pending; soliciting one is on the active roadmap (§8).
Until that review is complete, the prudent SubGenius will treat the
bridge as **experimental** and limit exposure accordingly. The
contracts have a `BridgeController.dailyMintCap` parameter currently
set conservatively for the same reason. Your Slack is yours to risk.

In the case of an emergency, the Gnosis Safe can:

- Pause mints (`pause()`)
- Increment `mintNonce`, invalidating all outstanding signatures in flight
- Rotate the watcher set
- Withdraw the operator from automated minting via the Safe module

There is no bridge action that can move locked (BOB) without burning the
corresponding wBOB. There is no bridge action that can mint wBOB without
the threshold of watchers signing. We have done the engineering. The
rest is up to "Bob."

---

## 7. Governance: Two Layers, Carefully Separated

**The bridge contract layer has no governance, and never will.**
`WBob.sol` and `BridgeController.sol` expose no
parameter-tuning knobs that members can vote on, no "treasury" of
locked (BOB) the contract can spend on its members' behalf, no upgrade
proxy. There is one privileged role (`DEFAULT_ADMIN_ROLE`), it is
held by a Gnosis Safe, and the Safe's only on-bridge powers are
operational (pause/unpause, watcher rotation, mint-cap adjustment).
The wrapped asset itself is governance-free for the same reason it is
tokenomics-free: the safest contract is the one with the fewest
reasons to change.

**The community-coordination layer is, separately, becoming a DAO.**
A Gnosis-native organization is being chartered under one of three
working names — pick whichever you can say without smirking:

- **The DAO of Slack — Dobbs Order of Wisdom** (a Decentralized Autonomous Organization, technically)
- **The Church of the SubGenius DAO — CoSG-DAO**
- **The Conspiracy of Slack** (turning their own word against them, classic move)

This sibling DAO holds a community treasury — funded by donations, an
opt-in slice of bridge tip-jar revenue, Devival merch, and whatever
else members vote to direct toward it. Membership is rooted in (BOB)
and wBOB holdings, with a contribution multiplier for ordained clergy
and verified pool / explorer / merchant operators. Members vote on:

- **Liquidity-pool seeding** — bootstrapping additional pairs beyond the current Oku liquidity; market-maker rebates; impermanent-loss buffers for early LPs.
- **Loss-reimbursement / mutual aid** — coordinated, vote-gated reimbursement when a frontend gets phished or an LP eats an honest IL bath. *Not a guarantee, a mutual-aid layer.*
- **Grants** — second pool operators, alternate explorers, merchant integrations, Android wallet work. Ordained clergy preferred, not required.
- **Treasury-funded buy-back-and-burn** — proposals to bridge wBOB out and cold-store the underlying (BOB), voted on like any other treasury allocation.
- **On-chain ordainments** — the Church has been ordaining members for $35-money-orders for forty years; there is no reason a DAO can't issue them as soulbound tokens carrying the same legal weight (which is to say, exactly as much as any member chooses to make of it).
- **X-Day rescheduling** — voted annually, as is tradition.

The DAO never touches the bridge contracts. The bridge contracts never
touch the DAO. They are deployed independently, audited independently,
and can fail or thrive independently. A wBOB holder who never votes,
never claims, never engages with the DAO loses nothing — their wBOB
remains 1:1 redeemable forever. A DAO member who never bridges remains
a DAO member.

If the bridge contracts themselves need upgrading, the Safe owners
will deploy a new version, publish the addresses, and (BOB) holders
will vote with their feet by either using the new bridge or not. This
is — and remains — the bridge's governance model. The DAO is a
separate concern.

Charter and contract addresses for the DAO are forthcoming. The
canonical place to track its progress is this repository's
`docs/` directory; an updated whitepaper edition will follow
once the charter is finalized.

Praise "Bob."

---

## 8. Roadmap

A roadmap is a confession of insecurity, but in the spirit of the
Conspiracy-tolerant ecosystem we're entering, we offer the following
non-binding aspirations:

- **Shipped (Q2 2026):** Bridge live on Gnosis mainnet. Contracts
  verified on Gnosisscan. Five watchers running on independent
  infrastructure. wBOB liquidity established on Oku (primary) with
  execution available via CoW Swap at
  `swap.cow.fi/#/100/swap/xDAI/wBOB` (secondary).
- **Q3 2026:** Solicit and complete an independent contract audit.
  Publish the report verbatim, findings and remediations alongside.
  Submit wBOB to Gnosis-ecosystem token registries. Coordinate the bridge
  through the (BOB) v0.11.0 LWMA-3 hard fork at block 1,888,808
  (~2026-07-16) — once the 100-block consensus reorg cap is live, the
  60-confirmation rule becomes provably above the worst-case attacker
  budget, not merely above the practical one.
- **Q4 2026:** Add the (BOB) v0.13.0 emergency-difficulty fork at block
  1,888,888 and the v0.12.0 AuxPoW fork at block 2,000,000 (~2026-12-17)
  to the watcher's chain-rule expectations. Publish a public post-mortem
  of every bug found, every attack attempted, and every praise-of-"Bob"
  successfully completed in the bridge's first six months.
- **X-Day** (continuously deferred): Achieve total Slack. Probably won't
  happen but we'll mint the wBOB anyway.

---

## 9. Conclusion

wBOB is a small piece of useful, boring, well-tested infrastructure that
lets (BOB) participate in the Gnosis Chain's DeFi ecosystem without
requiring its holders to apologize for owning a coin named after a
salesman in a 1950s pipe-tobacco advertisement. It is an exercise in
treating one specific cult's currency with the engineering seriousness
that is, frankly, far more than the cult deserves — and far less than
"Bob" *demands*.

The Conspiracy will not approve. That's how we know we got it right.

**PRAISE "Bob".**

---

## Appendix A: Canonical Deployment

| Asset | Address | Network |
|---|---|---|
| wBOB ERC-20 | `0x13550ae65f22A36f60A50d625B70b58666488263` | Gnosis (chainId 100) |
| BridgeController | `0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872` | Gnosis (chainId 100) |
| Bridge UI | https://bridge.subgenius.finance | — |
| Source: bridge | https://github.com/dobbscoin/wbob-bridge | — |
| Source: contracts | https://github.com/dobbscoin/wbob-contracts | — |
| Trading venue | Oku (liquidity) + CoW Swap: `https://swap.cow.fi/#/100/swap/xDAI/wBOB` | Gnosis |

## Appendix B: DepositId Canonical Formula

For any deposit, the unique identifier under which it is recorded as
processed is computed as:

```
depositId = keccak256(abi.encode(
    sourceChainName,         // e.g. "dobbscoin-mainnet"
    dobbscoinTxid,           // hex string, display order
    vout,                    // uint32
    depositAddress,          // string, base58check
    rawAmountSat,            // uint256
    recipientGnosisAddress   // address (uint160)
))
```

This guarantees that a single Dobbscoin output, paid to a single deposit
address, with a single recipient, with a single amount, can be minted
exactly once. The `processedDeposits[depositId]` mapping is set on first
mint and is never cleared. There is no condition under which a previously
processed deposit can be re-minted.

---

*"Bob" knows what He's doing. We just write the code.*
