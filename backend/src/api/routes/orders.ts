/**
 * GET /v1/orders/:id — fetch current order state and details.
 */

import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { bufferToHex } from '../../db/hex.js';

interface OrderResponse {
  orderId:               string;
  state:                 string;
  orderType:             string;
  recipientAddress:      string | null;
  amountSat:             string | null;
  depositAddress:        string | null;
  depositId:             string | null;   // 0x-prefixed bytes32, null until tx seen
  txid:                  string | null;
  vout:                  number | null;
  confirmations:         number | null;
  gnosisTxHash:          string | null;
  // Outbound-specific (null for inbound):
  burnTxHash:            string | null;   // Gnosis burn tx that requested the withdrawal
  payoutTxid:            string | null;   // Dobbscoin tx the bridge broadcast to pay the user
  payoutConfirmations:   number | null;
  // Inbound daily-cap split (null when not applicable / not decided yet):
  depositedSat:          string | null;   // what arrived on Dobbscoin
  mintedSat:             string | null;   // what is/was minted as wBOB ("0" = refunded whole)
  refundSat:             string | null;   // over today's cap, owed back to the sender (before fee)
  refundSentSat:         string | null;   // what the refund tx pays the sender (after fee)
  refundFeeSat:          string | null;
  refundAddress:         string | null;
  refundTxid:            string | null;   // only once broadcast
  refundState:           RefundState | null;
  refundConfirmations:   number | null;
  expiresAt:             string | null;
  createdAt:             string;
  updatedAt:             string;
}

/** Public refund state. 'signed' is folded into 'queued': nothing is on-chain yet. */
type RefundState = 'queued' | 'broadcast' | 'confirmed' | 'needs_attention' | 'too_small';

function publicRefundState(status: string | null): RefundState | null {
  switch (status) {
    case null:              return null;
    case 'queued':
    case 'signed':          return 'queued';
    case 'broadcast':       return 'broadcast';
    case 'confirmed':       return 'confirmed';
    case 'needs_attention': return 'needs_attention';
    case 'too_small':       return 'too_small';
    default:                return 'needs_attention';
  }
}

interface OrderRow {
  id:                    string;
  state:                 string;
  order_type:            string;
  user_gnosis_address:   string | null;
  amount_sat:            bigint | null;
  expires_at:            Date | null;
  created_at:            Date;
  updated_at:            Date;
  deposit_address:       string | null;
  deposit_id:            Buffer | null;
  txid:                  string | null;
  vout:                  number | null;
  confirmations:         number | null;
  gnosis_tx_hash:        string | null;
  burn_tx_hash:          string | null;
  payout_txid:           string | null;
  payout_confirmations:  number | null;
  deposit_amount_sat:    bigint | null;
  mint_amount_sat:       bigint | null;
  refund_excess_sat:     bigint | null;
  refund_amount_sat:     bigint | null;
  refund_fee_sat:        bigint | null;
  refund_address:        string | null;
  refund_txid:           string | null;
  refund_status:         string | null;
  refund_confirmations:  number | null;
}

const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

function toResponse(row: OrderRow): OrderResponse {
  const refundState = publicRefundState(row.refund_status);
  const onChain = refundState === 'broadcast' || refundState === 'confirmed';
  const isInbound = row.order_type === 'inbound';
  return {
    orderId:             row.id,
    state:               row.state,
    orderType:           row.order_type,
    recipientAddress:    row.user_gnosis_address,
    amountSat:           str(row.amount_sat),
    depositAddress:      row.deposit_address,
    depositId:           row.deposit_id !== null ? bufferToHex(row.deposit_id) : null,
    txid:                row.txid,
    vout:                row.vout,
    confirmations:       row.confirmations,
    gnosisTxHash:        row.gnosis_tx_hash,
    burnTxHash:          row.burn_tx_hash,
    payoutTxid:          row.payout_txid,
    payoutConfirmations: row.payout_confirmations,
    depositedSat:        isInbound ? str(row.deposit_amount_sat ?? row.amount_sat) : null,
    // A refund row records the split even when no mint_request exists (mint 0).
    mintedSat:           isInbound ? str(row.mint_amount_sat) : null,
    refundSat:           str(row.refund_excess_sat),
    refundSentSat:       str(row.refund_amount_sat),
    refundFeeSat:        refundState === 'too_small' ? null : str(row.refund_fee_sat),
    refundAddress:       row.refund_address,
    refundTxid:          onChain ? row.refund_txid : null,
    refundState,
    refundConfirmations: onChain ? row.refund_confirmations : null,
    expiresAt:           row.expires_at?.toISOString() ?? null,
    createdAt:           row.created_at.toISOString(),
    updatedAt:           row.updated_at.toISOString(),
  };
}

export async function ordersRoute(
  fastify: FastifyInstance,
  opts: { sql: Sql },
): Promise<void> {

  // ── GET /v1/orders?recipient=0x…&limit=50 ─────────────────────────────────
  // Lists recent orders for a given recipient (both inbound and outbound),
  // newest first. Used by the portal's history view on the persistent-address
  // deposit page.
  fastify.get<{ Querystring: { recipient: string; limit?: string } }>(
    '/v1/orders',
    async (request, reply) => {
      const { recipient } = request.query;
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        return reply.status(400).send({ error: 'Invalid recipient: must be a 0x Gnosis address' });
      }

      const rows = await opts.sql<OrderRow[]>`
        SELECT
          bo.id, bo.state, bo.order_type,
          bo.user_gnosis_address, bo.amount_sat,
          bo.expires_at, bo.created_at, bo.updated_at,
          sd.deposit_address, sd.deposit_id, sd.txid, sd.vout, sd.confirmations,
          mr.gnosis_tx_hash,
          wr.burn_tx_hash,
          p.txid          AS payout_txid,
          p.confirmations AS payout_confirmations,
          COALESCE(mr.deposit_amount_sat, dr.deposit_amount_sat, sd.amount_sat) AS deposit_amount_sat,
          COALESCE(mr.amount_sat, dr.mint_amount_sat) AS mint_amount_sat,
          dr.excess_sat     AS refund_excess_sat,
          dr.amount_sat     AS refund_amount_sat,
          dr.fee_sat        AS refund_fee_sat,
          dr.refund_address,
          dr.txid           AS refund_txid,
          dr.status         AS refund_status,
          dr.confirmations  AS refund_confirmations
        FROM bridge_orders bo
        LEFT JOIN source_deposits     sd ON sd.order_id = bo.id
        LEFT JOIN mint_requests       mr ON mr.order_id = bo.id
        LEFT JOIN withdrawal_requests wr ON wr.order_id = bo.id
        LEFT JOIN payouts             p  ON p.withdrawal_request_id = wr.id
        LEFT JOIN deposit_refunds     dr ON dr.order_id = bo.id
        WHERE bo.user_gnosis_address = ${recipient}
        ORDER BY bo.created_at DESC
        LIMIT ${limit}
      `;

      const response = rows.map(toResponse);

      return reply.send({ orders: response });
    },
  );

  // ── GET /v1/orders/by-withdrawal/:withdrawalId ─────────────────────────────
  // Maps a Gnosis WithdrawalRequested.withdrawalId (uint256 string) to the
  // bridge order UUID. Used by the portal after a withdrawal tx confirms.
  fastify.get<{ Params: { withdrawalId: string } }>(
    '/v1/orders/by-withdrawal/:withdrawalId',
    async (request, reply) => {
      const { withdrawalId } = request.params;
      if (!/^\d+$/.test(withdrawalId)) {
        return reply.status(400).send({ error: 'Invalid withdrawalId: must be a decimal integer' });
      }

      const rows = await opts.sql<{ id: string }[]>`
        SELECT bo.id
        FROM bridge_orders bo
        JOIN withdrawal_requests wr ON wr.order_id = bo.id
        WHERE wr.withdrawal_id = ${withdrawalId}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Order not found for this withdrawal ID' });
      }

      return reply.send({ orderId: rows[0]!.id });
    },
  );

  // ── GET /v1/orders/:id ────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/v1/orders/:id', async (request, reply) => {
    const { id } = request.params;

    // Basic UUID format check
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return reply.status(400).send({ error: 'Invalid order ID format' });
    }

    const rows = await opts.sql<OrderRow[]>`
      SELECT
        bo.id,
        bo.state,
        bo.order_type,
        bo.user_gnosis_address,
        bo.amount_sat,
        bo.expires_at,
        bo.created_at,
        bo.updated_at,
        sd.deposit_address,
        sd.deposit_id,
        sd.txid,
        sd.vout,
        sd.confirmations,
        mr.gnosis_tx_hash,
        wr.burn_tx_hash,
        p.txid          AS payout_txid,
        p.confirmations AS payout_confirmations,
        COALESCE(mr.deposit_amount_sat, dr.deposit_amount_sat, sd.amount_sat) AS deposit_amount_sat,
        COALESCE(mr.amount_sat, dr.mint_amount_sat) AS mint_amount_sat,
        dr.excess_sat     AS refund_excess_sat,
        dr.amount_sat     AS refund_amount_sat,
        dr.fee_sat        AS refund_fee_sat,
        dr.refund_address,
        dr.txid           AS refund_txid,
        dr.status         AS refund_status,
        dr.confirmations  AS refund_confirmations
      FROM bridge_orders bo
      LEFT JOIN source_deposits     sd ON sd.order_id = bo.id
      LEFT JOIN mint_requests       mr ON mr.order_id = bo.id
      LEFT JOIN withdrawal_requests wr ON wr.order_id = bo.id
      LEFT JOIN payouts             p  ON p.withdrawal_request_id = wr.id
      LEFT JOIN deposit_refunds     dr ON dr.order_id = bo.id
      WHERE bo.id = ${id}
    `;

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Order not found' });
    }

    const response = toResponse(rows[0]!);

    return reply.send(response);
  });
}
