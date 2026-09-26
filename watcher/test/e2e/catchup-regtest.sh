#!/usr/bin/env bash
# End-to-end reproduction of the 2026-06-18 lost-deposit incident, on regtest.
#
#   watcher running → watcher stopped → 10 (BOB) x2 paid to a persistent
#   deposit address and mined → watcher restarted → were the deposits ingested?
#
# Everything is throwaway: a regtest dobbscoind in a temp datadir on ports
# 28444/28445 (no peers), and a fresh database on a Postgres server you name,
# created here and dropped on exit. Minting and signing are not exercised: no
# backend runs, and the watcher is given a public test key and a dummy
# controller address, and never talks to Gnosis.
#
# Usage:
#   catchup-regtest.sh <watcher-dir-under-test>
# Env:
#   E2E_PG      libpq URL of a DISPOSABLE Postgres server, without a database
#               name, e.g. postgres://tester@127.0.0.1:5455  (required)
#   MIGRATIONS_BACKEND  backend/ dir whose migrate runner + migrations to use
#                       (default: the backend/ next to this script's repo)
set -uo pipefail

WATCHER_DIR=$(cd "${1:?usage: $0 <watcher-dir>}" && pwd)
: "${E2E_PG:?set E2E_PG to a disposable postgres server URL}"
HERE=$(cd "$(dirname "$0")" && pwd)
BACKEND=${MIGRATIONS_BACKEND:-$(cd "$HERE/../../../backend" && pwd)}

DB=wbob_catchup_e2e_$$
DB_URL="$E2E_PG/$DB"
WORK=$(mktemp -d /tmp/wbob-catchup-e2e.XXXXXX)
CLI="/usr/local/bin/dobbscoin-cli -datadir=$WORK/node"
WATCHER_PGID=""
FAILED=0

cleanup() {
  [ -n "$WATCHER_PGID" ] && kill -TERM -- "-$WATCHER_PGID" 2>/dev/null
  $CLI stop >/dev/null 2>&1
  for _ in $(seq 20); do [ -e "$WORK/node/d.pid" ] || break; sleep 0.5; done
  psql "$E2E_PG/postgres" -qc "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

q()     { psql "$DB_URL" -tAc "$1"; }
check() { # name, expected, actual
  if [ "$2" == "$3" ]; then echo "  PASS  $1  ($3)"; else echo "  FAIL  $1  expected [$2] got [$3]"; FAILED=1; fi
}

start_watcher() {
  local n0; n0=$(grep -c 'polling every' "$WORK/watcher.log" 2>/dev/null)
  ( cd "$WATCHER_DIR" && exec setsid env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" \
      DOBBSCOIN_RPC_URL=http://127.0.0.1:28445 DOBBSCOIN_RPC_USER=regtest DOBBSCOIN_RPC_PASS=regtestonly \
      DATABASE_URL="$DB_URL" \
      WATCHER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
      BRIDGE_CONTROLLER_ADDRESS=0x0000000000000000000000000000000000000001 \
      DOBBSCOIN_NETWORK=testnet POLL_INTERVAL_MS=500 ${EXTRA_ENV:-} \
      node --import=tsx src/index.ts >>"$WORK/watcher.log" 2>&1 ) &
  WATCHER_PGID=$!
  for _ in $(seq 120); do   # until this instance finishes catch-up and starts polling (or dies)
    [ "$(grep -c 'polling every' "$WORK/watcher.log")" -gt "${n0:-0}" ] && break
    kill -0 "$WATCHER_PGID" 2>/dev/null || break
    sleep 0.5
  done
  sleep 3   # several poll cycles
}
stop_watcher() {
  kill -TERM -- "-$WATCHER_PGID" 2>/dev/null
  wait "$WATCHER_PGID" 2>/dev/null
  WATCHER_PGID=""
}

echo "== code under test: $WATCHER_DIR ($(git -C "$WATCHER_DIR" log --oneline -1))"

# ── regtest node ──
mkdir -p "$WORK/node"
cat >"$WORK/node/dobbscoin.conf" <<CONF
regtest=1
txindex=1
server=1
listen=0
connect=0
dnsseed=0
port=28444
rpcport=28445
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=regtest
rpcpassword=regtestonly
CONF
setsid /usr/local/bin/dobbscoind -datadir="$WORK/node" -daemon -pid="$WORK/node/d.pid" </dev/null >/dev/null 2>&1
for _ in $(seq 60); do $CLI getblockcount >/dev/null 2>&1 && break; sleep 0.5; done
$CLI setgenerate true 101 >/dev/null   # mature one coinbase to spend

# ── throwaway bridge DB ──
psql "$E2E_PG/postgres" -qc "CREATE DATABASE $DB" || exit 1
( cd "$BACKEND" && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" DATABASE_URL="$DB_URL" \
    node --import=tsx src/db/migrate.ts ) >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; exit 1; }
ADDR=$($CLI getnewaddress)
q "INSERT INTO deposit_addresses (recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index)
   VALUES ('0x000000000000000000000000000000000000dEaD', 'dobbscoin-regtest', '$ADDR', 0)" >/dev/null
echo "== persistent deposit address $ADDR"

# ── 1. watcher running, a block goes by ──
start_watcher
$CLI setgenerate true 1 >/dev/null
sleep 3
echo "== watcher up; tip $($CLI getblockcount); stopping it"
stop_watcher

# ── 2. while it is down: two 10 (BOB) payments, mined, plus two more blocks ──
TX1=$($CLI sendtoaddress "$ADDR" 10)
TX2=$($CLI sendtoaddress "$ADDR" 10)
$CLI setgenerate true 3 >/dev/null
DEP_HEIGHT=$(( $($CLI getblockcount) - 2 ))
echo "== while down: paid 10 + 10 BOB in block $DEP_HEIGHT (txids ${TX1:0:8}… ${TX2:0:8}…); tip now $($CLI getblockcount)"

# ── 3. restart ──
start_watcher
echo "== watcher restarted"
check "deposit 1 in source_deposits" 1 "$(q "SELECT count(*) FROM source_deposits WHERE txid='$TX1'")"
check "deposit 2 in source_deposits" 1 "$(q "SELECT count(*) FROM source_deposits WHERE txid='$TX2'")"
check "bridge_orders for the deposits" 2 "$(q "SELECT count(*) FROM bridge_orders bo JOIN source_deposits sd ON sd.order_id=bo.id WHERE sd.txid IN ('$TX1','$TX2')")"
check "recorded at the right height" "$DEP_HEIGHT" "$(q "SELECT DISTINCT block_height FROM source_deposits WHERE txid IN ('$TX1','$TX2')")"

# ── 4. steady state after catch-up: mine to 6 confirmations ──
$CLI setgenerate true 3 >/dev/null
sleep 3
check "both FINALIZED after 6 confirmations" "DEPOSIT_FINALIZED" \
  "$(q "SELECT string_agg(DISTINCT bo.state, ',') FROM bridge_orders bo JOIN source_deposits sd ON sd.order_id=bo.id WHERE sd.txid IN ('$TX1','$TX2')")"

# ── 5. replay is a no-op: wind the cursor back before the deposits, restart ──
if [ "$(q "SELECT to_regclass('watcher_cursors') IS NOT NULL")" = t ] && \
   [ "$(q "SELECT count(*) FROM watcher_cursors")" = 1 ]; then
  check "cursor at the tip" "$($CLI getblockcount)" "$(q "SELECT block_height FROM watcher_cursors")"
  BEFORE="$(q "SELECT (SELECT count(*) FROM bridge_orders)||'/'||(SELECT count(*) FROM source_deposits)||'/'||(SELECT count(*) FROM audit_events)")"
  stop_watcher
  q "UPDATE watcher_cursors SET block_height=$((DEP_HEIGHT-2)), block_hash='$($CLI getblockhash $((DEP_HEIGHT-2)))'" >/dev/null
  start_watcher
  check "replayed $(( $($CLI getblockcount) - DEP_HEIGHT + 2 )) blocks" 1 "$(grep -c "catch-up done: replayed $(( $($CLI getblockcount) - DEP_HEIGHT + 2 )) block" "$WORK/watcher.log")"
  check "orders/deposits/audit rows unchanged by the replay" "$BEFORE" \
    "$(q "SELECT (SELECT count(*) FROM bridge_orders)||'/'||(SELECT count(*) FROM source_deposits)||'/'||(SELECT count(*) FROM audit_events)")"

  # ── 6. a gap over the cap: refuses to start, says how many are pending ──
  stop_watcher
  $CLI setgenerate true 5 >/dev/null
  EXTRA_ENV=WATCHER_CATCHUP_MAX_BLOCKS=3 start_watcher
  check "refuses with 5 pending over a cap of 3" 1 "$(grep -c 'refusing to start: 5 blocks are pending' "$WORK/watcher.log")"
  check "watcher process exited" gone "$(kill -0 "$WATCHER_PGID" 2>/dev/null && echo running || echo gone)"
else
  echo "  (no watcher_cursors row: this code has no cursor, replay check skipped)"
fi

echo "== watcher log (catch-up / ingest lines):"
grep -E 'catch-up|WARNING|auto-ingest|first-sight|advanced|CURSOR|error|refusing' "$WORK/watcher.log" | sed 's/^/    /'
stop_watcher
[ $FAILED = 0 ] && echo "== RESULT: PASS" || echo "== RESULT: FAIL"
exit $FAILED
