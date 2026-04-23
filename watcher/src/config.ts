/**
 * Watcher configuration — loaded from environment variables.
 *
 * All required vars must be set; missing vars throw at startup (fail-fast).
 */

import type { Hex, Address } from '@wbob/shared';
import { DOBBSCOIN_CHAIN_IDS } from '@wbob/shared';

export interface WatcherConfig {
  /** Bitcoin Core RPC connection. */
  rpc: {
    url: string;
    username: string;
    password: string;
    timeoutMs: number;
  };
  /** Postgres connection string. */
  databaseUrl: string;
  /** This watcher's signing key (32-byte hex, 0x-prefixed). */
  watcherPrivateKey: Hex;
  /** Deployed BridgeController address on Gnosis. */
  bridgeControllerAddress: Address;
  /** How often to poll for new blocks (ms). */
  pollIntervalMs: number;
  /** Min confirmations before DEPOSIT_CONFIRMED. */
  minConfirmations: number;
  /** Confirmations before DEPOSIT_FINALIZED. */
  finalConfirmations: number;
  /** Dobbscoin network: mainnet or testnet. */
  dobbscoinNetwork: 'mainnet' | 'testnet';
  /** Derived from dobbscoinNetwork. */
  dobbscoinChainId: bigint;
  /** How many blocks to keep in the reorg window. */
  reorgDepth: number;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function optionalEnvInt(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultVal;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) throw new Error(`${key} must be an integer, got: ${val}`);
  return parsed;
}

export function loadConfig(): WatcherConfig {
  const network = (process.env['DOBBSCOIN_NETWORK'] ?? 'mainnet') as 'mainnet' | 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`DOBBSCOIN_NETWORK must be "mainnet" or "testnet", got: ${network}`);
  }

  return {
    rpc: {
      url:       requireEnv('DOBBSCOIN_RPC_URL'),
      username:  requireEnv('DOBBSCOIN_RPC_USER'),
      password:  requireEnv('DOBBSCOIN_RPC_PASS'),
      timeoutMs: optionalEnvInt('DOBBSCOIN_RPC_TIMEOUT_MS', 30_000),
    },
    databaseUrl:             requireEnv('DATABASE_URL'),
    watcherPrivateKey:       requireEnv('WATCHER_PRIVATE_KEY') as Hex,
    bridgeControllerAddress: requireEnv('BRIDGE_CONTROLLER_ADDRESS') as Address,
    pollIntervalMs:          optionalEnvInt('POLL_INTERVAL_MS', 15_000),
    minConfirmations:        optionalEnvInt('MIN_CONFIRMATIONS', 3),
    finalConfirmations:      optionalEnvInt('FINAL_CONFIRMATIONS', 6),
    dobbscoinNetwork:        network,
    dobbscoinChainId:        DOBBSCOIN_CHAIN_IDS[network],
    reorgDepth:              optionalEnvInt('REORG_DEPTH', 200),
  };
}
