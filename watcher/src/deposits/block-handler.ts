/**
 * Block + orphan handlers: the deposit-ingest half of the watcher.
 *
 * Moved verbatim out of index.ts (they were closures inside main()) so they
 * can be driven directly by tests against a real database.
 */

import type { Sql } from 'postgres';
import { matchBlock } from './address-watcher.js';
import { computeDepositId } from './deposit-id.js';
import {
  computeConfirmationTransition,
  computeReorgRollback,
  type ConfirmationConfig,
} from './confirmation-tracker.js';
import {
  InboundState,
  assertInboundTransition,
  type Address,
} from '@wbob/shared';
import type { RpcBlock, BlockHeader } from '../rpc/types.js';

// ─── BYTEA helper ────────────────────────────────────────────────────────────

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ActiveDepositRow {
  order_id:          string;
  deposit_address:   string;
  source_chain_name: string;
  inbound_state:     InboundState;
  deposit_id:        Buffer | null;
  user_gnosis_address: string;
  amount_sat:        bigint | null;
  txid:              string | null;
  vout:              number | null;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function createBlockHandlers(sql: Sql<{ bigint: bigint }>, confirmationConfig: ConfirmationConfig) {
  // ── Block handler ─────────────────────────────────────────────────────────
  //
  // Runs on every new canonical block. Two passes:
  //   A) First-sighting — scan this block for outputs paying watched deposit
  //      addresses. First match records txid/vout/amount/depositId/block_*
  //      and advances DEPOSIT_ADDRESS_ASSIGNED → DEPOSIT_SEEN_MEMPOOL.
  //   B) Confirmation advancement — for every deposit already matched and in
  //      SEEN_MEMPOOL / CONFIRMED, compute confirmations from the tip height
  //      vs. its home block_height and drive SEEN → CONFIRMED → FINALIZED as
  //      thresholds are crossed. Also refreshes source_deposits.confirmations.

  async function handleBlock(block: RpcBlock): Promise<void> {
    // ── A. First-sighting ──────────────────────────────────────────────────
    const pendingFirst = await sql<ActiveDepositRow[]>`
      SELECT
        bo.id                   AS order_id,
        sd.deposit_address,
        sd.source_chain_name,
        bo.state                AS inbound_state,
        sd.deposit_id,
        bo.user_gnosis_address,
        bo.amount_sat,
        sd.txid,
        sd.vout
      FROM bridge_orders bo
      JOIN source_deposits sd ON sd.order_id = bo.id
      WHERE bo.order_type = 'inbound'
        AND bo.state = ${InboundState.DEPOSIT_ADDRESS_ASSIGNED}
        AND sd.txid IS NULL
    `;

    if (pendingFirst.length > 0) {
      const watchedSet = new Set(pendingFirst.map((d) => d.deposit_address));
      const matches = matchBlock(block, watchedSet);
      const depositsByAddress = new Map<string, ActiveDepositRow>();
      for (const d of pendingFirst) depositsByAddress.set(d.deposit_address, d);

      for (const match of matches) {
        const deposit = depositsByAddress.get(match.depositAddress);
        if (deposit === undefined) continue;

        const depositId = computeDepositId({
          sourceChainName:        deposit.source_chain_name,
          dobbscoinTxid:          match.txid,
          vout:                   match.vout,
          depositAddress:         match.depositAddress,
          rawAmountSat:           match.amountSat,
          recipientGnosisAddress: deposit.user_gnosis_address as Address,
        });

        try {
          await sql.begin(async (tx) => {
            const rows = await tx<{ state: InboundState }[]>`
              SELECT state FROM bridge_orders WHERE id = ${deposit.order_id} FOR UPDATE
            `;
            if (rows.length === 0) return;
            if (rows[0]!.state !== InboundState.DEPOSIT_ADDRESS_ASSIGNED) return;

            assertInboundTransition(
              InboundState.DEPOSIT_ADDRESS_ASSIGNED,
              InboundState.DEPOSIT_SEEN_MEMPOOL,
            );

            await tx`
              UPDATE source_deposits
              SET txid          = ${match.txid},
                  vout          = ${match.vout},
                  amount_sat    = ${match.amountSat},
                  deposit_id    = ${hexToBuffer(depositId)},
                  block_hash    = ${block.hash},
                  block_height  = ${block.height},
                  confirmations = 1,
                  updated_at    = now()
              WHERE order_id = ${deposit.order_id}
            `;

            await tx`
              UPDATE bridge_orders
              SET state = ${InboundState.DEPOSIT_SEEN_MEMPOOL}, updated_at = now()
              WHERE id = ${deposit.order_id}
            `;

            await tx`
              INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (
                ${deposit.order_id},
                'STATE_TRANSITION',
                ${InboundState.DEPOSIT_ADDRESS_ASSIGNED},
                ${InboundState.DEPOSIT_SEEN_MEMPOOL},
                'watcher',
                ${tx.json({ blockHash: block.hash, blockHeight: block.height, txid: match.txid, vout: match.vout })}
              )
            `;
          });
          console.log(`[watcher] first-sight orderId=${deposit.order_id} txid=${match.txid} height=${block.height}`);
        } catch (err) {
          console.error(`[watcher] first-sight error txid=${match.txid}:`, err);
        }
      }
    }

    // ── A2. Persistent-address auto-ingest ─────────────────────────────────
    // For any deposit in this block paying to an address tracked in
    // `deposit_addresses` that wasn't already claimed by a legacy quote
    // order in pass A1, auto-create a new bridge_orders row in
    // DEPOSIT_SEEN_MEMPOOL with the ACTUAL received amount. No quote, no
    // expiry, no "exact amount" required.
    type TrackedAddress = {
      recipient_gnosis_address: string;
      source_chain_name:        string;
      dobbscoin_address:        string;
      hd_index:                 number;
    };
    const tracked = await sql<TrackedAddress[]>`
      SELECT recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index
      FROM deposit_addresses
    `;
    if (tracked.length > 0) {
      const trackedSet = new Set(tracked.map((a) => a.dobbscoin_address));
      const matches = matchBlock(block, trackedSet);
      const addrMap = new Map<string, TrackedAddress>();
      for (const a of tracked) addrMap.set(a.dobbscoin_address, a);

      for (const match of matches) {
        const addrInfo = addrMap.get(match.depositAddress);
        if (addrInfo === undefined) continue;

        // Skip if this (txid, vout) is already recorded — either by A1 above
        // (legacy match of an existing DEPOSIT_ADDRESS_ASSIGNED order) or by
        // a previous watcher run that already ingested this deposit.
        const existing = await sql<{ id: string }[]>`
          SELECT id FROM source_deposits
          WHERE txid = ${match.txid} AND vout = ${match.vout}
          LIMIT 1
        `;
        if (existing.length > 0) continue;

        const depositId = computeDepositId({
          sourceChainName:        addrInfo.source_chain_name,
          dobbscoinTxid:          match.txid,
          vout:                   match.vout,
          depositAddress:         match.depositAddress,
          rawAmountSat:           match.amountSat,
          recipientGnosisAddress: addrInfo.recipient_gnosis_address as Address,
        });

        try {
          await sql.begin(async (tx) => {
            // Re-check inside the tx to avoid races with a concurrent watcher
            const stillNew = await tx<{ id: string }[]>`
              SELECT id FROM source_deposits
              WHERE txid = ${match.txid} AND vout = ${match.vout}
              LIMIT 1
            `;
            if (stillNew.length > 0) return;

            const orderRows = await tx<{ id: string }[]>`
              INSERT INTO bridge_orders (order_type, state, user_gnosis_address, amount_sat)
              VALUES ('inbound', ${InboundState.DEPOSIT_SEEN_MEMPOOL},
                      ${addrInfo.recipient_gnosis_address}, ${match.amountSat})
              RETURNING id
            `;
            const orderId = orderRows[0]!.id;

            await tx`
              INSERT INTO source_deposits (
                order_id, deposit_address, hd_index, source_chain_name,
                txid, vout, amount_sat, deposit_id,
                block_hash, block_height, confirmations
              ) VALUES (
                ${orderId}, ${match.depositAddress}, ${addrInfo.hd_index}, ${addrInfo.source_chain_name},
                ${match.txid}, ${match.vout}, ${match.amountSat}, ${hexToBuffer(depositId)},
                ${block.hash}, ${block.height}, 1
              )
            `;

            await tx`
              INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (
                ${orderId}, 'ORDER_CREATED',
                ${InboundState.QUOTE_CREATED}, ${InboundState.DEPOSIT_SEEN_MEMPOOL},
                'watcher',
                ${tx.json({ auto: true, blockHash: block.hash, blockHeight: block.height, txid: match.txid, vout: match.vout })}
              )
            `;
          });
          console.log(`[watcher] auto-ingested deposit orderId=new txid=${match.txid} amount=${match.amountSat} recipient=${addrInfo.recipient_gnosis_address}`);
        } catch (err) {
          console.error(`[watcher] auto-ingest error txid=${match.txid}:`, err);
        }
      }
    }

    // ── B. Confirmation advancement ────────────────────────────────────────
    type AdvanceRow = { order_id: string; state: InboundState; block_height: number };
    const pendingAdvance = await sql<AdvanceRow[]>`
      SELECT bo.id AS order_id, bo.state AS state, sd.block_height
      FROM bridge_orders bo
      JOIN source_deposits sd ON sd.order_id = bo.id
      WHERE bo.order_type = 'inbound'
        AND bo.state IN (${InboundState.DEPOSIT_SEEN_MEMPOOL}, ${InboundState.DEPOSIT_CONFIRMED})
        AND sd.block_height IS NOT NULL
    `;

    for (const row of pendingAdvance) {
      const confs = block.height - row.block_height + 1;
      if (confs < 1) continue;

      const intent = computeConfirmationTransition(row.state, confs, confirmationConfig);

      try {
        await sql.begin(async (tx) => {
          const rows = await tx<{ state: InboundState }[]>`
            SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
          `;
          if (rows.length === 0) return;
          let state = rows[0]!.state;
          if (state !== row.state) return;

          await tx`
            UPDATE source_deposits
            SET confirmations = ${confs}, updated_at = now()
            WHERE order_id = ${row.order_id}
          `;

          if (intent.transition === null) return;

          // computeConfirmationTransition returns the TARGET state (e.g. FINALIZED);
          // the FSM only allows one edge per step, so walk through intermediates.
          // Only multi-hop path in this FSM: SEEN_MEMPOOL → CONFIRMED → FINALIZED.
          const path: InboundState[] = [];
          if (
            state === InboundState.DEPOSIT_SEEN_MEMPOOL &&
            intent.transition === InboundState.DEPOSIT_FINALIZED
          ) {
            path.push(InboundState.DEPOSIT_CONFIRMED);
          }
          path.push(intent.transition);

          for (const next of path) {
            assertInboundTransition(state, next);

            await tx`
              UPDATE bridge_orders
              SET state = ${next}, updated_at = now()
              WHERE id = ${row.order_id}
            `;

            await tx`
              INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
              VALUES (
                ${row.order_id},
                'STATE_TRANSITION',
                ${state},
                ${next},
                'watcher',
                ${tx.json({ blockHash: block.hash, blockHeight: block.height, confirmations: confs })}
              )
            `;
            console.log(`[watcher] advanced orderId=${row.order_id} confs=${confs} ${state} → ${next}`);
            state = next;
          }
        });
      } catch (err) {
        console.error(`[watcher] advance error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Orphan handler ────────────────────────────────────────────────────────

  async function handleOrphan(header: BlockHeader): Promise<void> {
    const affected = await sql<{ order_id: string; state: InboundState }[]>`
      SELECT bo.id AS order_id, bo.state AS state
      FROM bridge_orders bo
      JOIN source_deposits sd ON sd.order_id = bo.id
      WHERE bo.order_type = 'inbound'
        AND bo.state = ${InboundState.DEPOSIT_CONFIRMED}
        AND sd.block_hash = ${header.hash}
    `;

    for (const row of affected) {
      const rollback = computeReorgRollback(row.state, 0, confirmationConfig);
      if (rollback === null) continue;

      try {
        await sql.begin(async (tx) => {
          const rows = await tx<{ state: InboundState }[]>`
            SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
          `;
          if (rows.length === 0) return;
          if (rows[0]!.state !== row.state) return;

          await tx`
            UPDATE bridge_orders
            SET state = ${rollback}, updated_at = now()
            WHERE id = ${row.order_id}
          `;

          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${row.order_id},
              'REORG_ROLLBACK',
              ${row.state},
              ${rollback},
              'watcher',
              ${tx.json({ orphanedBlockHash: header.hash, orphanedBlockHeight: header.height })}
            )
          `;
        });

        console.log(`[watcher] reorg rollback orderId=${row.order_id} ${row.state} → ${rollback}`);
      } catch (err) {
        console.error(`[watcher] reorg rollback error orderId=${row.order_id}:`, err);
      }
    }
  }

  return { handleBlock, handleOrphan };
}
