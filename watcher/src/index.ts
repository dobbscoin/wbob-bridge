/**
 * Watcher main entry point.
 *
 * Responsibilities:
 *   1. Poll the Dobbscoin node for new blocks
 *   2. Match block outputs against watched deposit addresses
 *   3. Drive inbound FSM transitions (SEEN_MEMPOOL → CONFIRMED → FINALIZED)
 *   4. Sign MintAuthorization structs for MINT_AUTH_CREATED orders
 *      (the backend executor creates those rows and sets the nonce/deadline)
 *
 * Separation of concerns:
 *   Watcher  — Dobbscoin chain watching + EIP-712 signing
 *   Backend  — mint_requests creation, executeMint submission, Gnosis watching
 */

import postgres from 'postgres';
import { DobbscoinRpcClient } from './rpc/client.js';
import { BlockPoller } from './chain/block-poller.js';
import { matchBlock } from './deposits/address-watcher.js';
import { computeDepositId } from './deposits/deposit-id.js';
import {
  computeConfirmationTransition,
  computeReorgRollback,
  type ConfirmationConfig,
} from './deposits/confirmation-tracker.js';
import { MintAuthorizer } from './signing/authorizer.js';
import { SignatureSubmitter } from './signing/submitter.js';
import type { SignatureEntry } from './signing/submitter.js';
import { loadConfig } from './config.js';
import {
  InboundState,
  assertInboundTransition,
  type Hex,
  type Address,
} from '@wbob/shared';
import type { RpcBlock, BlockHeader } from './rpc/types.js';

// ─── BYTEA helper ────────────────────────────────────────────────────────────

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}

function bufferToHex(buf: Buffer): Hex {
  return `0x${buf.toString('hex')}` as Hex;
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

interface PendingMintRow {
  order_id:         string;
  deposit_id:       Buffer;
  recipient_address: string;
  amount_sat:       bigint;
  mint_nonce:       bigint;
  deadline:         bigint;
  signatures:       SignatureEntry[];
  txid:             string;
  vout:             number;
  source_chain_name: string;
  deposit_address:  string;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  const sql = postgres(config.databaseUrl, {
    types: { bigint: postgres.BigInt },
  });

  const rpc = new DobbscoinRpcClient(config.rpc);
  const authorizer = new MintAuthorizer({
    privateKey: config.watcherPrivateKey,
    bridgeControllerAddress: config.bridgeControllerAddress,
  });
  const submitter = new SignatureSubmitter(sql);

  console.log(`[watcher] started. signer=${authorizer.address}`);

  const confirmationConfig: ConfirmationConfig = {
    minConfirmations: config.minConfirmations,
    finalConfirmations: config.finalConfirmations,
  };

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

  // ── Signing loop ──────────────────────────────────────────────────────────
  // Polls for MINT_AUTH_CREATED orders that the backend executor created.
  // Signs any that this watcher hasn't signed yet.

  async function pollForSigningOpportunities(): Promise<void> {
    const pending = await sql<PendingMintRow[]>`
      SELECT
        mr.order_id,
        mr.deposit_id,
        mr.recipient_address,
        mr.amount_sat,
        mr.mint_nonce,
        mr.deadline,
        mr.signatures,
        sd.txid,
        sd.vout,
        sd.source_chain_name,
        sd.deposit_address
      FROM mint_requests mr
      JOIN bridge_orders bo  ON bo.id = mr.order_id
      JOIN source_deposits sd ON sd.order_id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_AUTH_CREATED}
        AND mr.signature_count < 3
    `;

    for (const row of pending) {
      const sigs: SignatureEntry[] = row.signatures ?? [];
      const alreadySigned = sigs.some(
        (e) => e.signer.toLowerCase() === authorizer.address.toLowerCase(),
      );
      if (alreadySigned) continue;

      try {
        const depositIdHex = bufferToHex(row.deposit_id);

        // Dobbscoin txids are stored in the DB as raw 64-char hex (no 0x prefix —
        // native Bitcoin display form). EIP-712 bytes32 encoding needs a 0x-prefix
        // so viem treats the value as hex, not as UTF-8-encoded ASCII.
        const sourceTxHash = (row.txid.startsWith('0x') ? row.txid : `0x${row.txid}`) as Hex;
        const auth = {
          depositId:     depositIdHex,
          recipient:     row.recipient_address as Address,
          amount:        row.amount_sat,
          sourceChainId: config.dobbscoinChainId,
          sourceTxHash,
          sourceVout:    row.vout,
          deadline:      row.deadline,
          nonce:         row.mint_nonce,
        };

        const sig = await authorizer.sign(auth);
        const result = await submitter.submitSignature(depositIdHex, authorizer.address, sig);

        console.log(
          `[watcher] signed depositId=${depositIdHex} ` +
          `appended=${result.appended} totalSigs=${result.totalSignatures}`,
        );
      } catch (err) {
        console.error(`[watcher] signing error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Start polling ─────────────────────────────────────────────────────────

  const poller = new BlockPoller(rpc, {
    onBlock:  handleBlock,
    onOrphan: handleOrphan,
    onError:  (err) => { console.error('[watcher] polling error:', err); return false; },
  }, config.reorgDepth);

  // Run the signing loop in parallel with block polling
  async function signingLoop(): Promise<void> {
    while (true) {
      try {
        await pollForSigningOpportunities();
      } catch (err) {
        console.error('[watcher] signing loop error:', err);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }

  console.log(`[watcher] polling every ${config.pollIntervalMs}ms`);
  await Promise.all([
    poller.start(config.pollIntervalMs),
    signingLoop(),
  ]);
}

main().catch((err) => {
  console.error('[watcher] fatal error:', err);
  process.exit(1);
});
