# V1 → V2 cutover runbook

The wBOB token stays. Mint/burn authority moves from `BridgeController` (V1) to
`BridgeControllerV2`; the V1 `BridgeExecutorModule` is replaced by
`EmergencyPauseModule`. Rehearsed end to end in `wbob-contracts/test/ForkCutover.t.sol`
(fork of Gnosis, acting as the real Safe). Every step that touches the chain is a
Safe transaction approved by the owners. **Do the steps in order; each check must pass.**

Addresses (live): wBOB `0x13550ae65f22A36f60A50d625B70b58666488263` · V1
`0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872` · admin Safe
`0x09BD8F882f02c4A5F1FE9894f9Ad714Ec371e8f4` · V1 module
`0xd5ebf9EC7971B18A6b1e7f05Ee0BF96BE72e3410` · relayer (executor)
`0x032FaEe270fc9DDE30F721Ebbf739935De82F4a5` · V1 deploy block `45811925`.

## Before (no user impact)

1. Safe is 2-of-3 (do not move mint authority on one key).
2. A new, funded emergency operator key exists (it can freeze the token; it is not the relayer).
3. Deploy `BridgeControllerV2(wBOB, Safe, signers, mintLimitPerWindow, minWithdrawal, 1000001)`
   (born **paused**) and `EmergencyPauseModule(Safe, V2, wBOB, operator)`.
   `minWithdrawal` must be ≥ backend `PAYOUT_MIN_SAT` (100000).
4. Merge `v2-integration` and deploy it **with V1 settings** (`BRIDGE_CONTROLLER_VERSION` unset)
   **plus `LEGACY_BRIDGE_CONTROLLER_ADDRESSES=<V2>`**. Behavior is V1's; the backend startup
   check confirms the controller is V1 and probes V2. From now on the backend also scans V2's
   events, so even an accidentally early unpause of V2 can never lose a V2 withdrawal.

## Cutover

5. **Drain.** Stop accepting new deposits on the portal; wait until no inbound order is
   in flight, no V1 `executeMint` is pending, and **every refund is sent** (`deposit_refunds`
   only `broadcast`/`confirmed`/`too_small`). The export (step 8) refuses while an order created
   before B1 is unsettled or has an unsent refund (V2 can never record a refund on an imported
   output); deposits that arrive after B1 are left to V2.
   Then set **`REFUNDS_AUTO_SEND=false`** on the backend and restart it, until step 12: a
   refund sent in between would not be in the import, and V2 could later mint those coins too.
   Refunds decided in the window wait in `queued` and are recorded on V2, then sent, after the
   flip. A refund paid **by hand** at any time must get a `deposit_refunds` row (status
   `confirmed`) so the backend records it on V2.
6. **Safe tx 1** — stop V1 for good:
   `V1.pause()` · `V1.incrementMintNonce()` · `wBOB.revokeRole(BRIDGE_EXECUTOR_ROLE, V1)`.
   Note the block number **B1**.
7. Wait until B1 is **finalized** on Gnosis.
8. **Export** (read-only):
   `node --import=tsx scripts/v2-export-outpoints.ts --from 45811925 --to B1 --v1 <V1> --out v1-outpoints.json`
   It must print `final: true` with 0 problems. Any `--allow` entry needs a written reason.
9. **Safe tx 2** — hand over:
   `wBOB.grantRole(BRIDGE_EXECUTOR_ROLE, V2)` ·
   `V2.importProcessedOutpoints(batch)` for every batch in the file (300 keys each) ·
   `V2.grantRole(REFUND_MARKER_ROLE, relayer)` ·
   `Safe.enableModule(EmergencyPauseModule)` · `Safe.disableModule(EmergencyPauseModule, V1 module)`.
   **Do not** `sealImport` yet.
10. **Verify** (read-only): `scripts/v2-verify-import.ts --stage pre-seal --file v1-outpoints.json --v2 <V2>` → `OK (pre-seal)`.
11. **Safe tx:** `V2.sealImport()`.
12. **Flip the services** (backend + all five watchers + portal):
    `BRIDGE_CONTROLLER_ADDRESS=<V2>` · `BRIDGE_CONTROLLER_VERSION=2` ·
    `LEGACY_BRIDGE_CONTROLLER_ADDRESSES=<V1>` · `BRIDGE_EXECUTOR_MODULE_ADDRESS=<new module>` ·
    `EMERGENCY_OPERATOR_PRIVATE_KEY=<new key>` (never the relayer key; verify checks) ·
    `REFUNDS_AUTO_SEND` back to `true` ·
    portal `NEXT_PUBLIC_BRIDGE_CONTROLLER_ADDRESS=<V2>`,
    `NEXT_PUBLIC_BRIDGE_CONTROLLER_VERSION=2` (rebuild). Restart; the backend must log
    `controller … verified as V2` and no `BridgeGuard NOT READY`.
13. **Verify** (read-only): `--stage pre-unpause --relayer <relayer> --module <new module> --old-module <V1 module>
    --signers <the 5 watcher addresses> --mint-limit <mintLimitPerWindow as deployed, sat>` → `OK (pre-unpause)`.
    Both verify stages also check the RPC is Gnosis (chain 100) and V2's `SOURCE_CHAIN_ID` matches the export.
    Watch the first poll after the restart: signatures made before the flip are dropped as stale
    (a warning in the log, not an alert) and the watchers re-sign for V2.
14. **Safe tx 3:** `V2.unpause()`. Re-open deposits on the portal.

## After

15. Watch one real deposit and one real withdrawal through end to end.
16. Keep `LEGACY_BRIDGE_CONTROLLER_ADDRESSES=<V1>` set (harmless; the executor also refuses
    anything V1 already minted).

## Refunds under V2

Every refund **spends its own deposit output** (and only it), so one output can fund at most
one refund, by Dobbscoin consensus, whatever the DB says. A payout never spends a deposit
output that still owes a refund. The refund address is re-derived from the node at signing.
Every refund is recorded on V2 (`recordRefund`, relayer holds `REFUND_MARKER_ROLE`) before it
is sent, and only after the backend's own node confirms, every time: the deposit output is the
bridge's P2PKH at its hd_index, has the recorded value and FINAL_CONFIRMATIONS, and is unspent.
Refunds V2 has not recorded are never broadcast. A refund for an output imported from V1 is
refused by the contract; sent refunds are recorded too (outputs imported from V1 excepted).
If a stolen relayer key poisons an output's record, revoke the role, then the Safe calls
`resetOutpointRecord(key, trueValue, trueRefunded)` with the output's real value and the refund
really paid from it (only for outputs that never minted). Never zero a refund that was paid.
A `recordRefund` tx pending over 10 minutes raises one critical alert; it is never resent.

Known limit: before the cutover, refunds lived only in Postgres. The export imports every
deposit that is settled, has a refund row, or has any refund trace in the append-only
`audit_events`; a DB writer who could also erase audit rows before step 8 could still hide one.

## If something is wrong

- Before step 14 nothing is live on V2: fix and repeat the failed check.
- An outpoint missing from the import can be imported **after** the seal too (marking can only block).
- Emergency: the operator calls `pauseAll()` (controller **and** token). Only the Safe unpauses.
