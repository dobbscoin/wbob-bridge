/**
 * Gnosis event watcher — Phase 5.
 *
 * Polls BridgeController for WithdrawalRequested events.
 * For each new event:
 *   1. Creates an outbound bridge_order + withdrawal_requests row
 *   2. Drives FSM: WITHDRAW_REQUEST_CREATED → BURN_TX_SEEN
 *   3. Tracks confirmation depth; when reached: BURN_TX_SEEN → BURN_CONFIRMED → PAYOUT_QUEUED
 *
 * Persists the last processed Gnosis block in bridge_state so restarts
 * don't re-process events.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Hex as ViemHex,
} from 'viem';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import { OutboundState, assertOutboundTransition } from '@wbob/shared';
import type { BackendConfig } from '../config.js';

// ─── ABI ─────────────────────────────────────────────────────────────────────

const WITHDRAWAL_EVENT = parseAbiItem(
  'event WithdrawalRequested(uint256 indexed withdrawalId, address indexed sender, uint256 amount, string dobbscoinAddress, uint256 nonce)',
);

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ConfirmingBurnRow {
  order_id:         string;
  state:            OutboundState;
  burn_tx_hash:     string;
  burn_block_number: bigint;
}

// ─── GnosisEventWatcher ───────────────────────────────────────────────────────

export class GnosisEventWatcher {
  private readonly publicClient;

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
  ) {
    this.publicClient = createPublicClient({
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
  }

  // ── Main poll ────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    await this.processNewWithdrawals();
    await this.confirmPendingBurns();
  }

  async start(): Promise<void> {
    console.log('[gnosis-watcher] started');
    while (true) {
      try { await this.poll(); }
      catch (err) { console.error('[gnosis-watcher] poll error:', err); }
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  // ── Scan for new WithdrawalRequested events ───────────────────────────────

  private async processNewWithdrawals(): Promise<void> {
    const lastBlockStr = await this._getState('gnosis_last_block');
    const fromBlock = BigInt(lastBlockStr) + 1n;

    const currentBlock = await this.publicClient.getBlockNumber();
    if (fromBlock > currentBlock) return;

    const logs = await this.publicClient.getLogs({
      address: this.config.bridgeControllerAddress as ViemHex,
      event: WITHDRAWAL_EVENT,
      fromBlock,
      toBlock: currentBlock,
    });

    for (const log of logs) {
      const { withdrawalId, sender, amount, dobbscoinAddress, nonce } = log.args as {
        withdrawalId: bigint;
        sender:       string;
        amount:       bigint;
        dobbscoinAddress: string;
        nonce:        bigint;
      };

      try {
        await this._createWithdrawalOrder({
          withdrawalId,
          sender,
          amount,
          dobbscoinAddress,
          nonce,
          burnTxHash:    log.transactionHash ?? '',
          burnBlockNumber: log.blockNumber ?? 0n,
        });
      } catch (err) {
        console.error(`[gnosis-watcher] createWithdrawalOrder error withdrawalId=${withdrawalId}:`, err);
      }
    }

    await this._setState('gnosis_last_block', currentBlock.toString());
  }

  private async _createWithdrawalOrder(args: {
    withdrawalId:    bigint;
    sender:          string;
    amount:          bigint;
    dobbscoinAddress: string;
    nonce:           bigint;
    burnTxHash:      string;
    burnBlockNumber: bigint;
  }): Promise<void> {
    const {
      withdrawalId, sender, amount, dobbscoinAddress, nonce,
      burnTxHash, burnBlockNumber,
    } = args;

    await this.sql.begin(async (tx) => {
      // Idempotency: skip if already recorded
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM withdrawal_requests WHERE withdrawal_id = ${withdrawalId.toString()}
      `;
      if (existing.length > 0) return;

      // Create bridge_order
      const orderRows = await tx<{ id: string }[]>`
        INSERT INTO bridge_orders (
          order_type, state, user_gnosis_address, user_dobbscoin_address, amount_sat
        ) VALUES (
          'outbound',
          ${OutboundState.BURN_TX_SEEN},
          ${sender},
          ${dobbscoinAddress},
          ${amount}
        )
        RETURNING id
      `;
      const orderId = orderRows[0]!.id;

      // Create withdrawal_request
      await tx`
        INSERT INTO withdrawal_requests (
          order_id, withdrawal_id, sender_address, dobbscoin_address,
          amount_sat, user_nonce, burn_tx_hash, burn_block_number
        ) VALUES (
          ${orderId},
          ${withdrawalId.toString()},
          ${sender},
          ${dobbscoinAddress},
          ${amount},
          ${nonce},
          ${burnTxHash},
          ${burnBlockNumber}
        )
      `;

      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId},
          'ORDER_CREATED',
          ${OutboundState.WITHDRAW_REQUEST_CREATED},
          ${OutboundState.BURN_TX_SEEN},
          'gnosis-watcher',
          ${tx.json({
            withdrawalId: withdrawalId.toString(),
            burnTxHash,
            burnBlockNumber: burnBlockNumber.toString(),
          })}
        )
      `;
    });

    console.log(`[gnosis-watcher] recorded withdrawal withdrawalId=${withdrawalId}`);
  }

  // ── Confirm burns that have reached depth ────────────────────────────────

  private async confirmPendingBurns(): Promise<void> {
    const pendingBurns = await this.sql<ConfirmingBurnRow[]>`
      SELECT
        bo.id             AS order_id,
        bo.state,
        wr.burn_tx_hash,
        wr.burn_block_number
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      WHERE bo.state = ${OutboundState.BURN_TX_SEEN}
        AND wr.burn_block_number IS NOT NULL
    `;

    if (pendingBurns.length === 0) return;

    const currentBlock = await this.publicClient.getBlockNumber();

    for (const row of pendingBurns) {
      const depth = currentBlock - row.burn_block_number;
      if (depth < BigInt(this.config.gnosisConfirmationDepth)) continue;

      try {
        // BURN_TX_SEEN → BURN_CONFIRMED → PAYOUT_QUEUED
        await this._transitionOutbound(
          row.order_id, OutboundState.BURN_TX_SEEN, OutboundState.BURN_CONFIRMED,
          { depth: depth.toString() },
        );
        await this._transitionOutbound(
          row.order_id, OutboundState.BURN_CONFIRMED, OutboundState.PAYOUT_QUEUED,
          {},
        );

        console.log(`[gnosis-watcher] burn confirmed orderId=${row.order_id}`);
      } catch (err) {
        console.error(`[gnosis-watcher] confirmBurn error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async _transitionOutbound(
    orderId: string,
    from: OutboundState,
    to: OutboundState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    assertOutboundTransition(from, to);
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
          'gnosis-watcher', ${tx.json(metadata)}
        )
      `;
    });
  }

  private async _getState(key: string): Promise<string> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT value FROM bridge_state WHERE key = ${key}
    `;
    return rows[0]?.value ?? '0';
  }

  private async _setState(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO bridge_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()
    `;
  }
}
