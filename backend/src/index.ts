/**
 * Backend entry point.
 *
 * Starts five things concurrently:
 *   1. HTTP API server (Fastify)
 *   2. Mint executor (polls DB, calls executeMint on Gnosis)
 *   3. Gnosis event watcher (polls WithdrawalRequested events)
 *   4. Payout executor (builds/signs/broadcasts Dobbscoin payout txs)
 *   5. Solvency monitor (periodic collateral health checks + alerting)
 */

import postgres from 'postgres';
import { loadConfig } from './config.js';
import { createHdWallet } from './wallet/hd-wallet.js';
import { buildServer } from './api/server.js';
import { MintExecutor } from './executor/mint-executor.js';
import { DripSender } from './executor/drip-sender.js';
import { GnosisEventWatcher } from './gnosis/event-watcher.js';
import { PayoutExecutor } from './executor/payout-executor.js';
import { DobbscoinBackendRpc } from './dobbscoin/rpc.js';
import { BridgeGuard } from './gnosis/bridge-guard.js';
import { SolvencyMonitor } from './monitor/solvency-monitor.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const sql = postgres(config.databaseUrl, {
    types: { bigint: postgres.BigInt },
  });

  const wallet = createHdWallet(
    config.hdWalletXpub,
    config.hdDerivationPath,
    config.dobbscoinAddressVersion,
  );

  const rpc = new DobbscoinBackendRpc(config.dobbscoinRpc);

  if (BridgeGuard.isEnabled(config)) {
    const guard = new BridgeGuard(config);
    console.log('[backend] BridgeGuard enabled — emergency pause/unpause available');
    const guardOperator = await guard.getOperator().catch(() => 'unknown');
    console.log(`[backend] BridgeGuard operator: ${guardOperator}`);
  } else {
    console.warn('[backend] BridgeGuard DISABLED — set BRIDGE_EXECUTOR_MODULE_ADDRESS to enable emergency pause');
  }

  if (config.wBobAddress) {
    console.log(`[backend] SolvencyMonitor: wBOB address ${config.wBobAddress} (chain-sourced supply)`);
  } else {
    console.warn('[backend] SolvencyMonitor: WBOB_ADDRESS not set — supply estimated from DB');
  }

  const dripSender = config.dripEnabled ? new DripSender(sql, config) : null;
  if (dripSender) {
    console.log(`[backend] DripSender enabled — wallet ${dripSender.walletAddress}`);
  } else {
    console.log('[backend] DripSender disabled (DRIP_ENABLED=false)');
  }

  const monitor        = new SolvencyMonitor(sql, config, dripSender, rpc);
  const server         = await buildServer({ sql, wallet, config, monitor });
  const mintExecutor   = new MintExecutor(sql, config, dripSender);
  const gnosisWatcher  = new GnosisEventWatcher(sql, config);
  const payoutExecutor = new PayoutExecutor(sql, rpc, config);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    await server.close();
    await sql.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await Promise.all([
    // Bind to loopback by default; the public surface is the nginx vhost
    // that reverse-proxies from `bridge.subgenius.finance:443`. Override via
    // BIND_HOST=0.0.0.0 if you need direct external reachability (dev only).
    server.listen({ port: config.port, host: process.env.BIND_HOST ?? '127.0.0.1' }),
    mintExecutor.start(),
    gnosisWatcher.start(),
    payoutExecutor.start(),
    monitor.start(),
  ]);
}

main().catch((err) => {
  console.error('[backend] fatal error:', err);
  process.exit(1);
});
