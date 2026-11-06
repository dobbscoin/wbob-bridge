/**
 * Backend entry point.
 *
 * Starts five things concurrently:
 *   1. HTTP API server (Fastify)
 *   2. Mint executor (polls DB, calls executeMint on Gnosis)
 *   3. Gnosis event watcher (polls WithdrawalRequested events)
 *   4. Payout executor (builds/signs/broadcasts Dobbscoin payout txs, and
 *      refunds of deposit excess over the daily mint cap)
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
import { RefundExecutor } from './executor/refund-executor.js';
import { DobbscoinBackendRpc } from './dobbscoin/rpc.js';
import { BridgeGuard } from './gnosis/bridge-guard.js';
import { assertControllerVersion } from './gnosis/controller-version.js';
import { RefundRecorder } from './gnosis/refund-recorder.js';
import { AlertDispatcher } from './monitor/webhook.js';
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

  await assertControllerVersion(config);

  if (BridgeGuard.isEnabled(config)) {
    const guard = new BridgeGuard(config);
    // Nothing in the backend calls emergencyPause() automatically: it is for
    // ops scripts / a human. Say so, rather than imply automatic protection.
    console.log(config.bridgeControllerVersion === 2
      ? '[backend] BridgeGuard configured — pauseAll (controller + token) available to ops (NOT automatic); unpause is a Safe tx'
      : '[backend] BridgeGuard configured — emergency pause/unpause available to ops (NOT automatic)');
    const guardOperator = await guard.getOperator().catch(() => 'unknown');
    console.log(`[backend] BridgeGuard operator: ${guardOperator}`);
    const notReady = await guard.readiness();
    for (const p of notReady) console.error(`[backend] BridgeGuard NOT READY: ${p}`);
    if (notReady.length > 0) {
      await new AlertDispatcher({ webhookUrl: config.alertWebhookUrl, emailTo: config.alertEmailTo }).dispatch({
        level: 'critical', type: 'MINT_SUBMIT_BLOCKED', timestamp: new Date().toISOString(),
        message: `Emergency pause is NOT ready: ${notReady.join(' | ')}`,
        data: { problems: notReady },
      }).catch((err) => console.error('[backend] could not send the BridgeGuard alert:', err));
    }
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
  // Refunds of over-cap deposit excess ride the payout loop (no concurrent UTXO selection).
  // V2: refunds are recorded on-chain before they are sent (minted + refunded <= value).
  const refundExecutor = new RefundExecutor(sql, rpc, config, {
    recorder: config.bridgeControllerVersion === 2 ? new RefundRecorder(config) : null,
  });
  const payoutExecutor = new PayoutExecutor(sql, rpc, config, refundExecutor);
  console.log(`[backend] RefundExecutor: auto-send ${config.refundsAutoSend ? 'ON' : 'OFF (REFUNDS_AUTO_SEND=false)'}`);

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
