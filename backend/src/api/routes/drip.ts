/**
 * GET /v1/drip/:recipient
 *
 * Returns the current gas-drip state for a Gnosis recipient. The portal uses
 * this to render the right copy on /test:
 *   - no row             → "drip not configured for this recipient yet"
 *   - status=opted_in    → "drip will arrive with your first wBOB"
 *   - status=opted_out   → "drip declined — use the public faucet"
 *   - status=sent        → "drip received: <tx>"
 *   - status=failed      → "drip transaction reverted — see public faucet"
 *   - status=wallet_dry  → "drip pool empty right now — use public faucet"
 *   - status=recipient_has_gas → "not needed: wallet already has X xDAI"
 *
 * The route also reports whether DRIP is globally enabled, so the portal can
 * skip the section entirely when the feature is off.
 */

import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { BackendConfig } from '../../config.js';
import type { GasDripStatus } from '../../db/schema.js';

interface DripParams {
  recipient: string;
}

interface DripResponse {
  enabled: boolean;
  recipient: string;
  status: GasDripStatus | 'no_record';
  amountWei: string | null;
  gnosisTxHash: string | null;
  sentAt: string | null;
  /** Native xDAI (wei) the recipient held when the drip was skipped; status recipient_has_gas only. */
  recipientBalanceWei: string | null;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export async function dripRoute(
  fastify: FastifyInstance,
  opts: { sql: Sql; config: BackendConfig },
): Promise<void> {
  fastify.get<{ Params: DripParams }>('/v1/drip/:recipient', {
    schema: {
      params: {
        type: 'object',
        required: ['recipient'],
        properties: {
          recipient: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { recipient } = request.params;

    if (!isValidAddress(recipient)) {
      return reply.status(400).send({ error: 'Invalid recipient: must be a 0x Gnosis address' });
    }

    if (!opts.config.dripEnabled) {
      const response: DripResponse = {
        enabled: false,
        recipient,
        status: 'no_record',
        amountWei: null,
        gnosisTxHash: null,
        sentAt: null,
        recipientBalanceWei: null,
      };
      return reply.status(200).send(response);
    }

    try {
      const rows = await opts.sql<{
        status: GasDripStatus;
        amount_wei: string | null;
        gnosis_tx_hash: string | null;
        sent_at: Date | null;
        recipient_balance_wei: string | null;
      }[]>`
        SELECT status, amount_wei, gnosis_tx_hash, sent_at, recipient_balance_wei
        FROM gas_drips
        WHERE recipient_gnosis_address = ${recipient}
      `;

      const row = rows[0];
      const response: DripResponse = {
        enabled: true,
        recipient,
        status: row?.status ?? 'no_record',
        amountWei: row?.amount_wei ?? null,
        gnosisTxHash: row?.gnosis_tx_hash ?? null,
        sentAt: row?.sent_at ? new Date(row.sent_at).toISOString() : null,
        recipientBalanceWei: row?.status === 'recipient_has_gas' ? (row.recipient_balance_wei ?? null) : null,
      };
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, 'Failed to read drip state');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
