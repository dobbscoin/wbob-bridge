/**
 * Fastify server factory.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Sql } from 'postgres';
import type { HdWallet } from '../wallet/hd-wallet.js';
import { quotesRoute } from './routes/quotes.js';
import { ordersRoute } from './routes/orders.js';
import { healthRoute } from './routes/health.js';
import type { BackendConfig } from '../config.js';
import type { SolvencyMonitor } from '../monitor/solvency-monitor.js';

export async function buildServer(opts: {
  sql: Sql;
  wallet: HdWallet;
  config: BackendConfig;
  monitor: SolvencyMonitor;
}) {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: true });

  // Routes
  await fastify.register(quotesRoute, opts);
  await fastify.register(ordersRoute, { sql: opts.sql });
  await fastify.register(healthRoute, { monitor: opts.monitor });

  // Legacy liveness probe (kept for backwards compat)
  fastify.get('/health', async () => ({ status: 'ok' }));

  return fastify;
}
