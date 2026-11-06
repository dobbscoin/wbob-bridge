/**
 * GET /v1/withdraw-limits — the smallest withdrawal the bridge will pay out.
 *
 * A withdrawal at or under payoutMinSat is never signed: the payout executor
 * parks it in MANUAL_REVIEW, and the user's wBOB is already burned on-chain
 * (BridgeController only rejects zero). The portal reads this so its withdraw
 * form refuses such amounts BEFORE the user signs the burn. Static config.
 */

import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config.js';

export interface WithdrawLimitsResponse {
  /** Withdrawals must be STRICTLY greater than this (satoshis, 8 decimals). */
  payoutMinSat: string;
}

export async function withdrawLimitsRoute(
  fastify: FastifyInstance,
  opts: { config: Pick<BackendConfig, 'payoutMinSat'> },
): Promise<void> {
  const body: WithdrawLimitsResponse = { payoutMinSat: opts.config.payoutMinSat.toString() };
  fastify.get('/v1/withdraw-limits', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return body;
  });
}
