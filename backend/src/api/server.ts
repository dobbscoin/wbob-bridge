/**
 * Fastify server factory.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Sql } from 'postgres';
import type { HdWallet } from '../wallet/hd-wallet.js';
import { depositAddressRoute } from './routes/deposit-address.js';
import { ordersRoute } from './routes/orders.js';
import { healthRoute } from './routes/health.js';
import { dripRoute } from './routes/drip.js';
import type { BackendConfig } from '../config.js';
import type { SolvencyMonitor } from '../monitor/solvency-monitor.js';
import { mintCapRoute } from './routes/mint-cap.js';
import { withdrawLimitsRoute } from './routes/withdraw-limits.js';
import { ViemMintCapReader, type MintCapReader } from '../executor/mint-capacity.js';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { gnosis } from 'viem/chains';

export async function buildServer(opts: {
  sql: Sql;
  wallet: HdWallet;
  config: BackendConfig;
  monitor: SolvencyMonitor;
  capReader?: MintCapReader;
}) {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: true });

  // Routes
  // /v1/quotes REMOVED (review round 11): its HD-index allocator ignored
  // deposit_addresses, so a quote could take over another user's deposit
  // address. nginx already returned 410 for it since 2026-11-05.
  await fastify.register(depositAddressRoute, opts);     // modern: persistent address per recipient
  await fastify.register(ordersRoute, { sql: opts.sql });
  await fastify.register(healthRoute, { monitor: opts.monitor });
  await fastify.register(dripRoute, { sql: opts.sql, config: opts.config });

  // Daily mint cap for the deposit page. READ path → fallback() like every other reader.
  const capReader = opts.capReader ?? new ViemMintCapReader(
    createPublicClient({
      chain: gnosis,
      transport: fallback(opts.config.gnosisRpcUrls.map((u) => http(u))),
    }) as unknown as PublicClient,
    opts.config.wBobAddress,
    opts.config.bridgeControllerAddress,
    opts.config.bridgeControllerVersion,
  );
  await fastify.register(mintCapRoute, { sql: opts.sql, capReader });
  await fastify.register(withdrawLimitsRoute, { config: opts.config });

  // Legacy liveness probe (kept for backwards compat)
  fastify.get('/health', async () => ({ status: 'ok' }));

  return fastify;
}
