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
import { BlockPoller, CatchUpTooFarError } from './chain/block-poller.js';
import { loadCursor, saveCursor } from './chain/cursor-store.js';
import { createBlockHandlers } from './deposits/block-handler.js';
import type { ConfirmationConfig } from './deposits/confirmation-tracker.js';
import { MintAuthorizer } from './signing/authorizer.js';
import { SignatureSubmitter } from './signing/submitter.js';
import type { SignatureEntry } from './signing/submitter.js';
import { loadConfig } from './config.js';
import {
  InboundState,
  type Hex,
  type Address,
} from '@wbob/shared';
import type { RpcBlock } from './rpc/types.js';

// ─── BYTEA helper ────────────────────────────────────────────────────────────

function bufferToHex(buf: Buffer): Hex {
  return `0x${buf.toString('hex')}` as Hex;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

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

  const { handleBlock, handleOrphan } = createBlockHandlers(sql, confirmationConfig);

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

  // ── Block cursor ──────────────────────────────────────────────────────────
  // After each block's work is done, record it as this instance's cursor.
  // If a deposit in a block failed to record, stop advancing the cursor for
  // the rest of this run, so the next start replays from that block.

  const watcherId = authorizer.address.toLowerCase();
  let cursorHeldAt: number | null = null;

  async function onBlock(block: RpcBlock): Promise<void> {
    const complete = await handleBlock(block);
    if (!complete && cursorHeldAt === null) {
      cursorHeldAt = block.height;
      console.error(
        `[watcher] CURSOR HELD: a deposit in block ${block.height} failed to record (see error above). ` +
        `The cursor stays below this block until restart; restarting this watcher replays from here.`,
      );
    }
    if (cursorHeldAt === null) await saveCursor(sql, watcherId, { height: block.height, hash: block.hash });
  }

  // ── Start polling ─────────────────────────────────────────────────────────

  const poller = new BlockPoller(rpc, {
    onBlock,
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

  // Signing needs only the DB, so it starts now and runs through catch-up.
  const signing = signingLoop();

  // Catch up on blocks mined while this watcher was down, then poll normally.
  for (;;) {
    const cursor = await loadCursor(sql, watcherId);
    try {
      if (cursor === null) {
        console.warn(
          `[watcher] WARNING: no block cursor for watcher ${watcherId}. Starting at the current tip; ` +
          `NO blocks before it were replayed. Deposits mined while this watcher was down are not checked.`,
        );
      } else {
        console.log(`[watcher] catch-up: last processed block ${cursor.height} ${cursor.hash}`);
      }
      const r = await poller.catchUp(cursor, config.catchupMaxBlocks);
      console.log(`[watcher] catch-up done: replayed ${r.replayed} block(s), orphaned ${r.orphaned}, tip ${r.tipHeight}`);
      break;
    } catch (err) {
      if (err instanceof CatchUpTooFarError) throw err;
      console.error('[watcher] catch-up error, retrying:', err);
      await new Promise<void>((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }

  console.log(`[watcher] polling every ${config.pollIntervalMs}ms`);
  await Promise.all([
    poller.start(config.pollIntervalMs),
    signing,
  ]);
}

main().catch((err) => {
  console.error('[watcher] fatal error:', err);
  process.exit(1);
});
