# wBOB Bridge — Project Guide

Dobbscoin (BOB) ↔ Gnosis wBOB application-specific lock/mint + burn/release bridge.

## Repo layout

```
contracts/   Foundry — WBob ERC-20 + BridgeController
backend/     TypeScript — Bridge API + state machine + DB
watcher/     TypeScript — Dobbscoin chain observer (Bitcoin Core RPC)
portal/      Next.js — user-facing deposit/withdrawal UI
shared/      TypeScript — shared types (MintAuthorization, FSM states, etc.)
infra/       Docker Compose + deployment configs
```

## Phase status

- [x] Phase 1 — Contracts: WBob.sol + BridgeController.sol + full test suite
- [x] Phase 2 — DB schema + state machine core
- [x] Phase 3 — Dobbscoin watcher service
- [x] Phase 4 — Bridge API (deposit flow)
- [x] Phase 5 — Withdrawal/burn flow
- [x] Phase 6 — Safe integration + module
- [x] Phase 7 — Portal UI
- [x] Phase 8 — Solvency monitor + alerting

## Contracts

**Chain**: Gnosis mainnet (chain ID 100)  
**Solidity**: 0.8.27  
**Framework**: Foundry 1.6.0-nightly  
**Dependencies**: OpenZeppelin v5.3.0

### Key design decisions

- 3-of-5 threshold: three independent watcher EOAs must sign a `MintAuthorization` (EIP-712 typed data) before `executeMint()` can be called
- 8 decimals on wBOB to match Dobbscoin satoshi precision
- `mintNonce` (admin-incrementable) invalidates all outstanding authorizations for emergencies
- `processedDeposits[depositId]` is the primary replay protection — once set, never cleared
- `withdrawalNonces[address]` monotonically increases per user
- Signer dedup in `_countValidSignatures` prevents the same key counting multiple times
- Early exit at THRESHOLD in sig loop saves gas on the happy path
- DEFAULT_ADMIN_ROLE → Safe only; no hot wallet ever holds admin

### Running tests

```bash
cd contracts

# Unit + fuzz (1000 runs each)
forge test --no-match-path 'test/invariants/*' -v

# Invariant suite (500 runs × depth 100)
forge test --match-path 'test/invariants/*' -v

# All
forge test -v
```

### Deployment

```bash
cd contracts
cp ../.env.example ../.env
# fill in DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, WATCHER_1..5, etc.
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --chain-id 100
```

## Foundry nightly quirk

In this nightly build, `vm.prank` and `vm.expectRevert` are consumed by STATICCALL (view function calls), not just state-changing calls. Always cache role constants and build signatures before setting expectations:

```solidity
// WRONG — prank consumed by BRIDGE_EXECUTOR_ROLE() STATICCALL
vm.prank(admin);
wBOB.grantRole(wBOB.BRIDGE_EXECUTOR_ROLE(), executor);

// CORRECT
bytes32 role = wBOB.BRIDGE_EXECUTOR_ROLE();
vm.prank(admin);
wBOB.grantRole(role, executor);

// WRONG — expectRevert consumed by _buildSigs() which calls getMintAuthorizationDigest()
vm.expectRevert(...);
bridge.executeMint(auth, _buildSigs(auth, indices));

// CORRECT
bytes[] memory sigs = _buildSigs(auth, indices);
vm.expectRevert(...);
bridge.executeMint(auth, sigs);
```

## Trust model (Tier B)

- Mints require 3-of-5 independent watcher EOA signatures
- Pause, role changes, signer add/remove go through Gnosis Safe (threshold governed)
- Safe module (Phase 6) will constrain automated calls to: executeMint, pause, unpause
- No hot wallet ever holds DEFAULT_ADMIN_ROLE

## Key constants

| Name | Value |
|------|-------|
| MAX_SIGNERS | 5 |
| THRESHOLD | 3 |
| wBOB decimals | 8 |
| MAX_SUPPLY | 21,000,000 BOB (configurable at deploy) |
| Daily mint limit | 1,000,000 BOB/day (admin-adjustable) |
| Confirmation threshold | 6 (Dobbscoin, configurable via FINAL_CONFIRMATIONS env) |
| Min confirmations | 3 (configurable via MIN_CONFIRMATIONS env) |
| Reorg depth | 200 (configurable via REORG_DEPTH env) |

## Watcher (Phase 3)

```
watcher/src/
  config.ts              — env-var config loader (fail-fast)
  rpc/
    types.ts             — Bitcoin Core RPC type definitions
    client.ts            — DobbscoinRpcClient (native fetch, typed methods)
  chain/
    reorg-detector.ts    — sliding window reorg detection (pure)
    block-poller.ts      — tip tracking + event emission
  deposits/
    deposit-id.ts        — computeDepositId (viem keccak256 + ABI encode)
    address-watcher.ts   — matchBlock / matchTransaction (pure)
    confirmation-tracker.ts — computeConfirmationTransition / computeReorgRollback (pure)
  signing/
    authorizer.ts        — MintAuthorizer (EIP-712 via viem account.signTypedData)
    submitter.ts         — SignatureSubmitter (atomic append to mint_requests.signatures)
  index.ts               — main polling loop
```

### FSM location note

The pure FSM files (inbound.ts, outbound.ts) live in `shared/src/state-machine/` and are
re-exported from `@wbob/shared`. Both `backend` and `watcher` import them from there.
The DB-aware `FSMEngine` stays in `backend/src/state-machine/engine.ts`.

### DepositId canonical formula

```
keccak256(abi.encode(
  sourceChainName,         // string  e.g. "dobbscoin-mainnet"
  dobbscoinTxid,           // string  txid hex (RPC big-endian display)
  vout,                    // uint32
  depositAddress,          // string  Dobbscoin deposit address
  rawAmountSat,            // uint256 satoshis
  recipientGnosisAddress   // address Gnosis recipient
))
```

### Watcher env vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| DOBBSCOIN_RPC_URL | yes | — | http://host:port |
| DOBBSCOIN_RPC_USER | yes | — | RPC username |
| DOBBSCOIN_RPC_PASS | yes | — | RPC password |
| DATABASE_URL | yes | — | Postgres connection string |
| WATCHER_PRIVATE_KEY | yes | — | 0x-prefixed EOA private key |
| BRIDGE_CONTROLLER_ADDRESS | yes | — | Deployed BridgeController |
| DOBBSCOIN_NETWORK | no | mainnet | mainnet or testnet |
| POLL_INTERVAL_MS | no | 15000 | Block polling interval |
| MIN_CONFIRMATIONS | no | 3 | SEEN_MEMPOOL → CONFIRMED |
| FINAL_CONFIRMATIONS | no | 6 | CONFIRMED → FINALIZED |
| REORG_DEPTH | no | 200 | Reorg window size (blocks) |
