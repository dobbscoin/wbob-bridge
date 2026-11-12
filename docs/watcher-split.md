# Watcher split: minimal per-watcher env

Prep for moving 4 of the 5 watchers off vps3. Nothing here changes the live
units until you follow "Switch one unit over" below.

## Why

Today every `wbob-watcherN.service` loads the whole repo `.env`
(`EnvironmentFile=/home/btcbob/claude/wBOB/.env`) and picks its key with
`bash -c 'export WATCHER_PRIVATE_KEY=$WATCHER_N_KEY && exec npm start'`. So each
watcher process holds the deployer key, `HD_WALLET_XPRIV`, the executor key, the
emergency operator key, the drip hot-wallet key and all five watcher keys. A
watcher needs one key and no other secret except its DB and RPC logins.

## What the watcher reads (watcher/src/config.ts)

| Variable | Required | Notes |
|---|---|---|
| `DOBBSCOIN_RPC_URL`, `DOBBSCOIN_RPC_USER`, `DOBBSCOIN_RPC_PASS` | yes | its own node |
| `DOBBSCOIN_RPC_TIMEOUT_MS` | no (30000) | |
| `DATABASE_URL` | yes | will become a per-watcher role |
| `WATCHER_PRIVATE_KEY` | yes | from `WATCHER_N_KEY` |
| `BRIDGE_CONTROLLER_ADDRESS` | yes | |
| `BRIDGE_CONTROLLER_VERSION` | no (1) | live is 2 |
| `HD_WALLET_XPUB` | yes | public; derives bridge deposit addresses |
| `HD_DERIVATION_PATH` | no (`m/0`) | |
| `DOBBSCOIN_ADDRESS_VERSION` | no (0) | |
| `DOBBSCOIN_NETWORK` | no (mainnet) | |
| `POLL_INTERVAL_MS`, `MIN_CONFIRMATIONS`, `FINAL_CONFIRMATIONS`, `REORG_DEPTH`, `WATCHER_CATCHUP_MAX_BLOCKS` | no | |
| `V2_PRE_CUTOVER_ALLOW` | yes when version 2 | a FILE PATH (`~/claude/wbob-cutover/v2-pre-cutover-allow.json`); copy the file to the same path on another box |
| `V2_MIN_DEPOSIT_HEIGHT` | no | must agree with the allow file |

No other `process.env` reads exist in `watcher/src` or `shared/src`.

## Generate the env file

    cd ~/claude/wBOB && scripts/watcher-env.sh 1

Writes `~/.config/wbob/watcher-1.env` (dir 0700, file 0600) with only the
variables above, lines copied verbatim from `.env` (last occurrence wins, as in
systemd), plus `WATCHER_PRIVATE_KEY` renamed from `WATCHER_1_KEY`. Prints names
only. Re-run it after any change to those values in `.env`.

Check it without printing values:

    sed 's/=.*//' ~/.config/wbob/watcher-1.env

## Proposed unit

As a drop-in, so the live unit file stays as it is and switching back is
deleting one file. `~/.config/systemd/user/wbob-watcher1.service.d/minimal-env.conf`:

    [Service]
    # Replace (not add to) the shared .env and the bash key-export wrapper.
    EnvironmentFile=
    EnvironmentFile=%h/.config/wbob/watcher-1.env
    ExecStart=
    ExecStart=/usr/local/bin/node --import=tsx src/index.ts
    UMask=0077
    NoNewPrivileges=yes

The same unit written out in full (for a new box, adjust paths):

    [Unit]
    Description=wBOB Bridge — watcher signer 1
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    WorkingDirectory=/home/btcbob/claude/wBOB/watcher
    EnvironmentFile=%h/.config/wbob/watcher-1.env
    Environment=PATH=/usr/local/bin:/usr/bin:/bin
    ExecStart=/usr/local/bin/node --import=tsx src/index.ts
    UMask=0077
    NoNewPrivileges=yes
    Restart=on-failure
    RestartSec=5s
    StandardOutput=journal
    StandardError=journal

    [Install]
    WantedBy=default.target

`node --import=tsx src/index.ts` is exactly what `npm start` runs; calling node
directly drops the bash and npm layers, so `MainPID` is the watcher itself.

## Switch one unit over

1. `scripts/watcher-env.sh 1` and check the names (above).
2. Create the drop-in above, then `systemctl --user daemon-reload`.
3. `systemctl --user restart wbob-watcher1`
4. Check:
   - `journalctl --user -u wbob-watcher1 -n 30` shows `[watcher] started. signer=0x…`
     with watcher 1's address and `catch-up done`, and no `Missing required` error.
   - The process holds only the intended names:
     `tr '\0' '\n' < /proc/$(systemctl --user show -p MainPID --value wbob-watcher1)/environ | sed 's/=.*//' | sort`
     (expect the table's names plus systemd's own, e.g. PATH, HOME, INVOCATION_ID; no
     `DEPLOYER_PRIVATE_KEY`, `HD_WALLET_XPRIV`, `EXECUTOR_PRIVATE_KEY`,
     `EMERGENCY_OPERATOR_PRIVATE_KEY`, `DRIP_HOT_WALLET_PRIVATE_KEY`, `WATCHER_*_KEY`).
   - The next mint gets this watcher's signature.

## Switch back

    rm ~/.config/systemd/user/wbob-watcher1.service.d/minimal-env.conf
    systemctl --user daemon-reload && systemctl --user restart wbob-watcher1

## Before a watcher moves to another box

- Its own DB role. It needs: SELECT on `bridge_orders`, `source_deposits`,
  `mint_requests`, `deposit_addresses`, `watcher_cursors`; INSERT on
  `bridge_orders`, `source_deposits`, `audit_events`, `watcher_cursors`; UPDATE on
  `bridge_orders`, `source_deposits`, `mint_requests`, `watcher_cursors`.
- **No INSERT/UPDATE/DELETE on `deposit_addresses`.** The signer now refuses any
  mint whose recipient is not the one registered there for the deposit address
  (watcher/src/signing/node-check.ts). That check is only as good as that table:
  only the backend API may write it.
- With UPDATE on `mint_requests` a compromised watcher can still delete other
  watchers' signatures (stalls mints, cannot redirect them).
- Its own Dobbscoin node (the pre-signing checks ask the watcher's own node).
- The V2 allow file at the path in `V2_PRE_CUTOVER_ALLOW`.
