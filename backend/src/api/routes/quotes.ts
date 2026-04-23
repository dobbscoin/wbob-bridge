/**
 * POST /v1/quotes — create a bridge order and assign a Dobbscoin deposit address.
 *
 * Flow:
 *   1. Validate recipient (Gnosis address) and requested amount.
 *   2. Get the next HD wallet index from DB (MAX(hd_index) + 1).
 *   3. Derive the Dobbscoin deposit address.
 *   4. Create bridge_orders row (QUOTE_CREATED → DEPOSIT_ADDRESS_ASSIGNED).
 *   5. Create source_deposits row with deposit address + hd_index.
 *   6. Return the deposit address, order ID, and expiry.
 */

import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { HdWallet } from '../../wallet/hd-wallet.js';
import { InboundState } from '@wbob/shared';
import type { BackendConfig } from '../../config.js';

interface QuoteBody {
  recipientAddress: string;   // Gnosis 0x address
  amountSat: string;          // Satoshi amount as string (avoids JSON number precision loss)
}

interface QuoteResponse {
  orderId: string;
  depositAddress: string;
  amountSat: string;
  expiresAt: string;          // ISO 8601
}

const QUOTE_TTL_SECONDS = 3600; // 1 hour

// Basic Gnosis/Ethereum address validation
function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export async function quotesRoute(
  fastify: FastifyInstance,
  opts: { sql: Sql; wallet: HdWallet; config: BackendConfig },
): Promise<void> {
  fastify.post<{ Body: QuoteBody }>('/v1/quotes', {
    schema: {
      body: {
        type: 'object',
        required: ['recipientAddress', 'amountSat'],
        properties: {
          recipientAddress: { type: 'string' },
          amountSat: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { recipientAddress, amountSat: amountSatStr } = request.body;

    // Validate address
    if (!isValidAddress(recipientAddress)) {
      return reply.status(400).send({ error: 'Invalid recipientAddress: must be a 0x Gnosis address' });
    }

    // Validate amount
    let amountSat: bigint;
    try {
      amountSat = BigInt(amountSatStr);
      if (amountSat <= 0n) throw new Error('non-positive');
    } catch {
      return reply.status(400).send({ error: 'Invalid amountSat: must be a positive integer string' });
    }

    try {
      const result = await opts.sql.begin(async (tx) => {
        // Get next HD index atomically
        const rows = await tx<{ max_index: number | null }[]>`
          SELECT MAX(hd_index) AS max_index FROM source_deposits
        `;
        const nextIndex = (rows[0]!.max_index ?? -1) + 1;

        // Derive deposit address
        const depositAddress = opts.wallet.deriveAddress(nextIndex);

        const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);

        // Create bridge order
        const orderRows = await tx<{ id: string }[]>`
          INSERT INTO bridge_orders (
            order_type, state, user_gnosis_address, amount_sat, expires_at
          ) VALUES (
            'inbound',
            ${InboundState.DEPOSIT_ADDRESS_ASSIGNED},
            ${recipientAddress},
            ${amountSat},
            ${expiresAt}
          )
          RETURNING id
        `;
        const orderId = orderRows[0]!.id;

        // Create source_deposit with assigned address (deposit_id NULL until tx seen)
        await tx`
          INSERT INTO source_deposits (
            order_id, deposit_address, hd_index, source_chain_name
          ) VALUES (
            ${orderId},
            ${depositAddress},
            ${nextIndex},
            ${opts.config.sourceChainName}
          )
        `;

        await tx`
          INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
          VALUES (
            ${orderId},
            'ORDER_CREATED',
            ${InboundState.QUOTE_CREATED},
            ${InboundState.DEPOSIT_ADDRESS_ASSIGNED},
            'api',
            ${tx.json({ depositAddress, hdIndex: nextIndex, recipientAddress })}
          )
        `;

        return { orderId, depositAddress, expiresAt };
      });

      const response: QuoteResponse = {
        orderId:        result.orderId,
        depositAddress: result.depositAddress,
        amountSat:      amountSat.toString(),
        expiresAt:      result.expiresAt.toISOString(),
      };

      return reply.status(201).send(response);
    } catch (err) {
      request.log.error(err, 'Failed to create quote');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
