/**
 * Mint executor.
 *
 * Two jobs run in parallel:
 *
 * Job 1 — Auth creator:
 *   Polls for DEPOSIT_FINALIZED orders without a mint_requests row.
 *   Fetches the current mintNonce from BridgeController on Gnosis.
 *   Creates the mint_requests row (nonce, deadline, recipient, amount).
 *   Transitions the order to MINT_AUTH_CREATED.
 *   (Watchers then sign the authorization automatically.)
 *
 * Job 2 — Mint submitter:
 *   Polls for MINT_AUTH_CREATED orders with signature_count >= THRESHOLD (3).
 *   Calls BridgeController.executeMint() on Gnosis.
 *   Transitions order to MINT_SUBMITTED.
 *   Polls for tx receipt, then transitions MINT_CONFIRMED → COMPLETED.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import { InboundState, assertInboundTransition, type Address, type Hex } from '@wbob/shared';
import { hexToBuffer, bufferToHex } from '../db/hex.js';
import type { BackendConfig } from '../config.js';
import type { DripSender } from './drip-sender.js';

// ─── ABI ─────────────────────────────────────────────────────────────────────

const BRIDGE_ABI = parseAbi([
  'function mintNonce() view returns (uint256)',
  'function executeMint((bytes32 depositId, address recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout, uint256 deadline, uint256 nonce) auth, bytes[] signatures) external',
]);

const SIGNATURE_THRESHOLD = 3;

// ─── DB row types ─────────────────────────────────────────────────────────────

interface FinalizedOrderRow {
  order_id:           string;
  deposit_id:         Buffer;
  user_gnosis_address: string;
  amount_sat:         bigint;
  txid:               string;
  vout:               number;
  source_chain_name:  string;
  deposit_address:    string;
  source_chain_id:    bigint;
  hd_index:           number;
}

interface ReadyToMintRow {
  order_id:           string;
  deposit_id:         Buffer;
  recipient_address:  string;
  amount_sat:         bigint;
  mint_nonce:         bigint;
  deadline:           bigint;
  signatures:         Array<{ signer: string; sig: string }>;
  txid:               string;
  vout:               number;
}

interface SubmittedRow {
  order_id:       string;
  gnosis_tx_hash: string;
}

// ─── MintExecutor ─────────────────────────────────────────────────────────────

export class MintExecutor {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
    private readonly dripSender: DripSender | null = null,
  ) {
    this.account = privateKeyToAccount(config.executorPrivateKey as ViemHex);
    this.publicClient = createPublicClient({
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
  }

  // ── Job 1: create mint_requests for DEPOSIT_FINALIZED orders ─────────────

  async createPendingAuths(): Promise<void> {
    // Find DEPOSIT_FINALIZED orders without a mint_requests row yet
    const orders = await this.sql<FinalizedOrderRow[]>`
      SELECT
        bo.id                   AS order_id,
        sd.deposit_id,
        bo.user_gnosis_address,
        COALESCE(sd.amount_sat, bo.amount_sat) AS amount_sat,
        sd.txid,
        sd.vout,
        sd.source_chain_name,
        sd.deposit_address,
        sd.hd_index
      FROM bridge_orders bo
      JOIN source_deposits sd ON sd.order_id = bo.id
      LEFT JOIN mint_requests mr ON mr.order_id = bo.id
      WHERE bo.order_type = 'inbound'
        AND bo.state = ${InboundState.DEPOSIT_FINALIZED}
        AND mr.order_id IS NULL
        AND sd.deposit_id IS NOT NULL
        AND sd.txid IS NOT NULL
    `;

    if (orders.length === 0) return;

    // Fetch current mintNonce once (same for all pending auths this round)
    const mintNonce = await this.publicClient.readContract({
      address: this.config.bridgeControllerAddress as ViemHex,
      abi: BRIDGE_ABI,
      functionName: 'mintNonce',
    }) as bigint;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.config.mintDeadlineSeconds);

    for (const order of orders) {
      try {
        await this.sql.begin(async (tx) => {
          // Re-check state under lock
          const rows = await tx<{ state: string }[]>`
            SELECT state FROM bridge_orders WHERE id = ${order.order_id} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0]!.state !== InboundState.DEPOSIT_FINALIZED) return;

          const depositIdHex = bufferToHex(order.deposit_id);

          await tx`
            INSERT INTO mint_requests (
              order_id, deposit_id, recipient_address, amount_sat,
              mint_nonce, deadline, signatures, signature_count
            ) VALUES (
              ${order.order_id},
              ${order.deposit_id},
              ${order.user_gnosis_address},
              ${order.amount_sat},
              ${mintNonce},
              ${deadline},
              '[]'::jsonb,
              0
            )
            ON CONFLICT (order_id) DO NOTHING
          `;

          // Register the deposit UTXO in the bridge pool (idempotent via UNIQUE txid+vout)
          await tx`
            INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index)
            VALUES (
              ${order.order_id},
              ${order.txid},
              ${order.vout},
              ${order.amount_sat},
              ${order.deposit_address},
              ${order.hd_index}
            )
            ON CONFLICT (txid, vout) DO NOTHING
          `;

          await tx`
            UPDATE bridge_orders
            SET state = ${InboundState.MINT_AUTH_CREATED}, updated_at = now()
            WHERE id = ${order.order_id}
          `;

          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${order.order_id},
              'STATE_TRANSITION',
              ${InboundState.DEPOSIT_FINALIZED},
              ${InboundState.MINT_AUTH_CREATED},
              'mint-executor',
              ${tx.json({ depositId: depositIdHex, mintNonce: mintNonce.toString(), deadline: deadline.toString() })}
            )
          `;
        });

        console.log(`[executor] created mint auth for orderId=${order.order_id}`);
      } catch (err) {
        console.error(`[executor] createPendingAuths error orderId=${order.order_id}:`, err);
      }
    }
  }

  // ── Job 2: call executeMint when threshold signatures collected ───────────

  async submitReadyMints(): Promise<void> {
    const ready = await this.sql<ReadyToMintRow[]>`
      SELECT
        mr.order_id,
        mr.deposit_id,
        mr.recipient_address,
        mr.amount_sat,
        mr.mint_nonce,
        mr.deadline,
        mr.signatures,
        sd.txid,
        sd.vout
      FROM mint_requests mr
      JOIN bridge_orders bo ON bo.id = mr.order_id
      JOIN source_deposits sd ON sd.order_id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_AUTH_CREATED}
        AND mr.signature_count >= ${SIGNATURE_THRESHOLD}
        AND mr.gnosis_tx_hash IS NULL
    `;

    for (const row of ready) {
      try {
        const depositIdHex = bufferToHex(row.deposit_id) as ViemHex;
        const sigs = row.signatures.map((e) => e.sig as ViemHex);
        // DB stores Dobbscoin txids in raw Bitcoin-display hex (no 0x prefix).
        // bytes32 ABI encoding needs a 0x-prefixed hex; must match the value the
        // watchers signed (same prefix logic in watcher/src/index.ts).
        const sourceTxHash = (row.txid.startsWith('0x') ? row.txid : `0x${row.txid}`) as ViemHex;

        const txHash = await this.walletClient.writeContract({
          address: this.config.bridgeControllerAddress as ViemHex,
          abi: BRIDGE_ABI,
          functionName: 'executeMint',
          args: [
            {
              depositId:    depositIdHex,
              recipient:    row.recipient_address as ViemHex,
              amount:       row.amount_sat,
              sourceChainId: this.config.dobbscoinChainId,
              sourceTxHash,
              sourceVout:   row.vout,
              deadline:     row.deadline,
              nonce:        row.mint_nonce,
            },
            sigs,
          ],
        });

        // Record tx hash and advance FSM
        await this.sql.begin(async (tx) => {
          const rows = await tx<{ state: string }[]>`
            SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0]!.state !== InboundState.MINT_AUTH_CREATED) return;

          await tx`
            UPDATE mint_requests
            SET gnosis_tx_hash = ${txHash}, updated_at = now()
            WHERE order_id = ${row.order_id}
          `;

          await tx`
            UPDATE bridge_orders
            SET state = ${InboundState.MINT_SUBMITTED}, updated_at = now()
            WHERE id = ${row.order_id}
          `;

          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${row.order_id},
              'STATE_TRANSITION',
              ${InboundState.MINT_AUTH_CREATED},
              ${InboundState.MINT_SUBMITTED},
              'mint-executor',
              ${tx.json({ gnosisTxHash: txHash })}
            )
          `;
        });

        console.log(`[executor] submitted executeMint txHash=${txHash} orderId=${row.order_id}`);
      } catch (err) {
        console.error(`[executor] submitReadyMints error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Job 3: confirm MINT_SUBMITTED → MINT_CONFIRMED → COMPLETED ───────────

  async confirmSubmittedMints(): Promise<void> {
    const submitted = await this.sql<SubmittedRow[]>`
      SELECT mr.order_id, mr.gnosis_tx_hash
      FROM mint_requests mr
      JOIN bridge_orders bo ON bo.id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_SUBMITTED}
        AND mr.gnosis_tx_hash IS NOT NULL
    `;

    for (const row of submitted) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({
          hash: row.gnosis_tx_hash as ViemHex,
        }).catch(() => null);

        if (receipt === null) continue; // not yet mined

        if (receipt.status === 'reverted') {
          // executeMint reverted — mark FAILED
          await this._transitionOrder(
            row.order_id,
            InboundState.MINT_SUBMITTED,
            InboundState.FAILED,
            { gnosisTxHash: row.gnosis_tx_hash, reason: 'tx reverted' },
          );
          console.warn(`[executor] executeMint reverted orderId=${row.order_id}`);
          continue;
        }

        // Success: MINT_SUBMITTED → MINT_CONFIRMED → COMPLETED
        await this._transitionOrder(
          row.order_id,
          InboundState.MINT_SUBMITTED,
          InboundState.MINT_CONFIRMED,
          { gnosisTxHash: row.gnosis_tx_hash, blockNumber: receipt.blockNumber.toString() },
        );

        await this.sql`
          UPDATE mint_requests
          SET gnosis_block_number = ${receipt.blockNumber},
              confirmed_at = now(),
              updated_at = now()
          WHERE order_id = ${row.order_id}
        `;

        await this._transitionOrder(
          row.order_id,
          InboundState.MINT_CONFIRMED,
          InboundState.COMPLETED,
          { gnosisTxHash: row.gnosis_tx_hash },
        );

        console.log(`[executor] mint confirmed orderId=${row.order_id}`);

        // ── Gas drip (Option 2) ─────────────────────────────────────────
        // Fire-and-log only — failures must not affect the mint outcome.
        if (this.dripSender) {
          try {
            const [recip] = await this.sql<{ user_gnosis_address: string; amount_sat: bigint }[]>`
              SELECT user_gnosis_address, amount_sat
              FROM bridge_orders
              WHERE id = ${row.order_id}
            `;
            if (recip?.user_gnosis_address && recip.amount_sat) {
              const decision = await this.dripSender.sendDripIfEligible(
                recip.user_gnosis_address,
                row.order_id,
                recip.amount_sat,
              );
              console.log(
                `[executor] drip orderId=${row.order_id} recipient=${recip.user_gnosis_address} outcome=${decision.outcome}` +
                  (decision.txHash ? ` tx=${decision.txHash}` : '') +
                  (decision.message ? ` ${decision.message}` : ''),
              );
            }
          } catch (err) {
            console.error(`[executor] drip threw (mint already completed) orderId=${row.order_id}:`, err);
          }
        }
      } catch (err) {
        console.error(`[executor] confirmSubmittedMints error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Main poll loop ────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    await this.createPendingAuths();
    await this.submitReadyMints();
    await this.confirmSubmittedMints();
  }

  async start(): Promise<void> {
    console.log(`[executor] started. executor=${this.account.address}`);
    while (true) {
      try {
        await this.poll();
      } catch (err) {
        console.error('[executor] poll error:', err);
      }
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _transitionOrder(
    orderId: string,
    from: InboundState,
    to: InboundState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    assertInboundTransition(from, to);

    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== from) return;

      await tx`
        UPDATE bridge_orders SET state = ${to}, updated_at = now()
        WHERE id = ${orderId}
      `;

      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId}, 'STATE_TRANSITION', ${from}, ${to},
          'mint-executor', ${tx.json(metadata)}
        )
      `;
    });
  }
}
