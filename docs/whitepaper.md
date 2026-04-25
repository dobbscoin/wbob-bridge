# wBOB: A Trust-Halved Bridge for the Backed-by-Nothing-Powered-by-Everything Coin

**A Whitepaper of Quasi-Sober Engineering with a Slack-Adjacent Disposition**

*v0.1 — Submitted to the Conspiracy under protest, pending "Bob"'s endorsement.*

---

## Abstract

We present **wBOB**, a 1:1 wrapped representation of Dobbscoin (BOB) on the
Gnosis Chain. Unlike the Pink-money systems of the Conspiracy, wBOB does not
pretend to be backed by an inflated "promise" or a "treasury." It is backed
by the only thing that has ever mattered: actual BOB, locked in addresses
whose private keys are scattered across a 3-of-5 threshold of independent
SubGenius-aligned operators, none of whom can spend the funds alone. wBOB
mints when BOB is locked. wBOB burns when BOB is released. The book
balances. "Bob" is satisfied. Slack increases.

This document describes the cryptographic, operational, and theological
foundations of the bridge.

---

## 1. Motivation

Dobbscoin (BOB) is an ancient and stubborn coin: a Bitcoin Core fork from
the pre-BIP68 era, sized 8 satoshi-decimals like its progenitor, and
governed by precisely as much consensus as its miners can be bothered to
agree to. It is, in short, a coin that does not give a damn — a property
the Conspiracy has not yet figured out how to monetize. This makes BOB the
most spiritually qualified asset in cryptocurrency.

But BOB has a problem: it's stuck on a chain where no one builds. The
DeFi rituals of the modern age — liquidity pools, swaps, lending markets,
yield strategies — happen on EVM chains. BOB holders who wish to perform
these rites must either (a) sell their BOB for Conspiracy-money, which is
unthinkable, or (b) wrap it.

We chose (b).

We chose Gnosis Chain specifically because it is the EVM ecosystem most
likely to share BOB's contempt for the Conspiracy's preferred currencies.
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
- An incoming BOB deposit is detected by all five watchers. Each watcher
  independently verifies that:
  1. The transaction lands on the Dobbscoin canonical chain
  2. It pays the correct amount to a watched address
  3. It has reached the finalization threshold (6 confirmations, ~6 minutes)
  4. The deposit hasn't already been processed (replay prevention via
     a deterministic `depositId` derived from txid + vout + amount + recipient)
- Once confirmed, each watcher signs an **EIP-712 typed `MintAuthorization`**
  — a structured data blob that includes the `depositId`, the recipient
  address, the amount, the source chain ID, and a deadline.
- When 3 of 5 signatures accumulate, **anyone** may submit them to
  `BridgeController.executeMint()`, which verifies the threshold, dedupes
  signers, marks the `depositId` as processed (forever, no clearing), and
  mints the corresponding wBOB.

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

To redeem wBOB for BOB, the holder calls `requestWithdrawal(amount,
dobbscoinAddress)` on the BridgeController. The contract:

1. Burns the wBOB from the caller's balance immediately. There is no
   approval step, no allowance, no two-transaction dance. You pay your
   tithe and you walk away lighter.
2. Emits a `WithdrawalRequested` event containing the burn details and a
   monotonically-increasing per-user nonce.
3. The bridge backend, watching Gnosis for these events, waits 12 blocks
   for finalization, then constructs a Dobbscoin transaction that pays
   the requested address from the bridge's hot-wallet UTXO pool. The hot
   wallet's keys are derived from a hierarchical deterministic seed that
   the bridge operator alone holds.
4. Once the Dobbscoin payout transaction reaches 3 confirmations, the
   bridge marks the order `COMPLETED`, and Slack returns to its previous
   level.

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
to anything other than the right to redeem it for the underlying BOB. The
total supply of wBOB at any moment equals the sat-amount of BOB locked in
the bridge's deposit addresses, modulo the cumulative payout fees that
have leaked to Dobbscoin miners.

There is no premine. There is no team allocation. There is no "vesting."
If you hold wBOB, the only thing it represents is your claim on an equal
amount of BOB that is sitting on the Dobbscoin chain. We will not be
adding utility, governance, or NFT-staking-yield-farming-loyalty-program
features. The whole point of wBOB is that it's *exactly as stupid as the
underlying coin, just on a different chain*.

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
review is currently underway. Until that review is complete, the prudent
SubGenius will treat the bridge as **experimental** and limit exposure
accordingly. Your Slack is yours to risk.

In the case of an emergency, the Gnosis Safe can:

- Pause mints (`pause()`)
- Increment `mintNonce`, invalidating all outstanding signatures in flight
- Rotate the watcher set
- Withdraw the operator from automated minting via the Safe module

There is no bridge action that can move locked BOB without burning the
corresponding wBOB. There is no bridge action that can mint wBOB without
the threshold of watchers signing. We have done the engineering. The
rest is up to "Bob."

---

## 7. Governance: There Isn't Any

There is no DAO. There is no governance token. There is no on-chain
voting. The bridge is operated by people who care about Dobbscoin, the
Church of the SubGenius, and the principle that some software should
just **work** without 14 layers of meta-political performance.

If the bridge needs upgrading, the Safe owners will deploy a new version,
publish the addresses, and BOB holders will vote with their feet by
either using the new bridge or not. This is the entire governance model.

Praise "Bob."

---

## 8. Roadmap

A roadmap is a confession of insecurity, but in the spirit of the
Conspiracy-tolerant ecosystem we're entering, we offer the following
non-binding aspirations:

- **Q2 2026**: Independent contract audit. Onboard 5 distinct watcher
  operators on independent infrastructure. Verify contracts on
  Gnosisscan.
- **Q3 2026**: Submit to Gnosis-ecosystem token registries. Establish
  initial liquidity pools (WXDAI/wBOB on Balancer CoW AMM live as of
  whitepaper submission; further pairs as warranted).
- **Q4 2026**: Publish a post-mortem of all bugs found, all attacks
  attempted, and all praise-of-"Bob" successfully completed.
- **X-Day** (continuously deferred): Achieve total Slack. Probably won't
  happen but we'll mint the wBOB anyway.

---

## 9. Conclusion

wBOB is a small piece of useful, boring, well-tested infrastructure that
lets BOB participate in the Gnosis Chain's DeFi ecosystem without
requiring its holders to apologize for owning a coin named after a
salesman in a 1950s pipe-tobacco advertisement. It is an exercise in
treating one specific cult's currency with the engineering seriousness
that is, frankly, far more than the cult deserves — and far less than
"Bob" *demands*.

The Conspiracy will not approve. That's how we know we got it right.

**PRAISE "BOB".**

---

## Appendix A: Canonical Deployment

| Asset | Address | Network |
|---|---|---|
| wBOB ERC-20 | `0x13550ae65f22A36f60A50d625B70b58666488263` | Gnosis (chainId 100) |
| BridgeController | `0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872` | Gnosis (chainId 100) |
| Bridge UI | https://bridge.subgenius.finance | — |
| Source: bridge | https://github.com/dobbscoin/wbob-bridge | — |
| Source: contracts | https://github.com/dobbscoin/wbob-contracts | — |
| WXDAI/wBOB pool | `0xefe75bf74018a5257a73f31b434ab91a20f57847` (Balancer CoW AMM) | Gnosis |

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
