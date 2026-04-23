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

  async function handleBlock(block: RpcBlock): Promise<void> {
    const activeDeposits = await sql<ActiveDepositRow[]>`
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
        AND bo.state NOT IN (
          ${InboundState.COMPLETED},
          ${InboundState.FAILED},
          ${InboundState.REFUNDED},
          ${InboundState.MINT_SUBMITTED},
          ${InboundState.MINT_CONFIRMED},
          ${InboundState.MINT_AUTH_CREATED}
        )
    `;

    if (activeDeposits.length === 0) return;

    const watchedSet = new Set(activeDeposits.map((d) => d.deposit_address));
    const matches = matchBlock(block, watchedSet);
    if (matches.length === 0) return;

    const depositsByAddress = new Map<string, ActiveDepositRow>();
    for (const d of activeDeposits) depositsByAddress.set(d.deposit_address, d);

    for (const match of matches) {
      const deposit = depositsByAddress.get(match.depositAddress);
      if (deposit === undefined) continue;

      const currentState = deposit.inbound_state;
      const confirmations = block.confirmations ?? 1;

      const intent = computeConfirmationTransition(currentState, confirmations, confirmationConfig);
      if (intent.transition === null) continue;

      try {
        await sql.begin(async (tx) => {
          const rows = await tx<{ state: InboundState }[]>`
            SELECT state FROM bridge_orders WHERE id = ${deposit.order_id} FOR UPDATE
          `;
          if (rows.length === 0) return;
          const actual = rows[0]!.state;
          if (actual !== currentState) return;

          const toState = intent.transition!;
          assertInboundTransition(actual, toState);

          // First time seeing this deposit: record txid/vout/amount + compute depositId
          if (deposit.txid === null) {
            const depositId = computeDepositId({
              sourceChainName:        deposit.source_chain_name,
              dobbscoinTxid:          match.txid,
              vout:                   match.vout,
              depositAddress:         match.depositAddress,
              rawAmountSat:           match.amountSat,
              recipientGnosisAddress: deposit.user_gnosis_address as Address,
            });

            await tx`
              UPDATE source_deposits
              SET txid       = ${match.txid},
                  vout       = ${match.vout},
                  amount_sat = ${match.amountSat},
                  deposit_id = ${hexToBuffer(depositId)},
                  block_hash = ${block.hash},
                  block_height = ${block.height},
                  updated_at = now()
              WHERE order_id = ${deposit.order_id}
            `;
          }

          await tx`
            UPDATE bridge_orders
            SET state = ${toState}, updated_at = now()
            WHERE id = ${deposit.order_id}
          `;

          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${deposit.order_id},
              'STATE_TRANSITION',
              ${currentState},
              ${toState},
              'watcher',
              ${tx.json({ blockHash: block.hash, blockHeight: block.height, txid: match.txid, vout: match.vout })}
            )
          `;
        });
      } catch (err) {
        console.error(`[watcher] block handler error txid=${match.txid}:`, err);
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

        const auth = {
          depositId:     depositIdHex,
          recipient:     row.recipient_address as Address,
          amount:        row.amount_sat,
          sourceChainId: config.dobbscoinChainId,
          sourceTxHash:  row.txid as Hex,
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
