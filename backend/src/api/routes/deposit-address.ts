/**
 * GET /v1/deposit-address?recipient=0x…
 *
 * Returns the persistent Dobbscoin deposit address for a Gnosis recipient.
 * If the recipient has never been issued an address, one is allocated from
 * the HD wallet, persisted to `deposit_addresses`, and returned.
 *
 * This is the modern replacement for the quote-based flow: users get a single
 * address they can send any amount to, any number of times, from any wallet.
 * Each confirmed deposit is auto-credited by the watcher.
 */

import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { HdWallet } from '../../wallet/hd-wallet.js';
import type { BackendConfig } from '../../config.js';

interface DepositAddressQuery {
  recipient: string;
}

interface DepositAddressResponse {
  recipientAddress: string;
  depositAddress:   string;
  sourceChainName:  string;
  hdIndex:          number;
  createdAt:        string;   // ISO 8601
}

interface DepositAddressRow {
  recipient_gnosis_address: string;
  source_chain_name:        string;
  dobbscoin_address:        string;
  hd_index:                 number;
  created_at:               Date;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export async function depositAddressRoute(
  fastify: FastifyInstance,
  opts: { sql: Sql; wallet: HdWallet; config: BackendConfig },
): Promise<void> {
  fastify.get<{ Querystring: DepositAddressQuery }>('/v1/deposit-address', {
    schema: {
      querystring: {
        type: 'object',
        required: ['recipient'],
        properties: {
          recipient: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { recipient } = request.query;

    if (!isValidAddress(recipient)) {
      return reply.status(400).send({ error: 'Invalid recipient: must be a 0x Gnosis address' });
    }

    const chain = opts.config.sourceChainName;

    try {
      const row = await opts.sql.begin(async (tx) => {
        // Return the most recently created address for this recipient, if any.
        const existing = await tx<DepositAddressRow[]>`
          SELECT recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index, created_at
          FROM deposit_addresses
          WHERE recipient_gnosis_address = ${recipient}
            AND source_chain_name = ${chain}
          ORDER BY created_at DESC
          LIMIT 1
        `;
        if (existing.length > 0) return existing[0]!;

        // Allocate a new HD index. Deposit path is m/0/N, same space used by
        // legacy source_deposits.hd_index; source both tables so we can't
        // collide with a legacy row that hasn't been backfilled yet.
        const depMaxRows = await tx<{ max_index: number | null }[]>`
          SELECT MAX(hd_index) AS max_index FROM deposit_addresses
        `;
        const legacyMaxRows = await tx<{ max_index: number | null }[]>`
          SELECT MAX(hd_index) AS max_index FROM source_deposits
        `;
        const depMax    = depMaxRows[0]?.max_index    ?? -1;
        const legacyMax = legacyMaxRows[0]?.max_index ?? -1;
        const nextIndex = Math.max(depMax, legacyMax) + 1;

        const depositAddress = opts.wallet.deriveAddress(nextIndex);

        const inserted = await tx<DepositAddressRow[]>`
          INSERT INTO deposit_addresses
            (recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index)
          VALUES
            (${recipient}, ${chain}, ${depositAddress}, ${nextIndex})
          RETURNING recipient_gnosis_address, source_chain_name, dobbscoin_address, hd_index, created_at
        `;
        return inserted[0]!;
      });

      const response: DepositAddressResponse = {
        recipientAddress: row.recipient_gnosis_address,
        depositAddress:   row.dobbscoin_address,
        sourceChainName:  row.source_chain_name,
        hdIndex:          row.hd_index,
        createdAt:        new Date(row.created_at).toISOString(),
      };
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, 'Failed to resolve deposit address');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
