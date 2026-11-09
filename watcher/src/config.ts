/**
 * Watcher configuration — loaded from environment variables.
 *
 * All required vars must be set; missing vars throw at startup (fail-fast).
 */

import type { Hex, Address, BridgeControllerVersion } from '@wbob/shared';
import { DOBBSCOIN_CHAIN_IDS, parseBridgeControllerVersion } from '@wbob/shared';
import { readFileSync } from 'node:fs';

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
  /** 1 = BridgeController (EIP-712 version '1'), 2 = BridgeControllerV2 (version '2'). */
  bridgeControllerVersion: BridgeControllerVersion;
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
  /** Most blocks to replay automatically on startup; above this, refuse to start. */
  catchupMaxBlocks: number;
  /** The bridge's deposit xpub + path + P2PKH version, to derive its addresses locally. */
  hdWalletXpub: string;
  hdDerivationPath: string;
  dobbscoinAddressVersion: number;
  /**
   * V2 only (review round 6 #2): never sign for a deposit confirmed below this
   * Dobbscoin height (the height at the cutover) unless its outpoint is in
   * v2PreCutoverAllowed. Which pre-cutover deposits were refunded is only known
   * to Postgres, so pre-cutover deposits mint on V2 only from a reviewed list.
   */
  v2MinDepositHeight: number | null;
  /** "txid:vout" of pre-cutover deposits allowed to mint on V2 (from the export's leftToV2 list). */
  v2PreCutoverAllowed: Set<string>;
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

function loadPreCutoverAllow(path: string | undefined): { minDepositHeight: number | null; outpoints: Set<string> } {
  if (path === undefined || path === '') return { minDepositHeight: null, outpoints: new Set() };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { outpoints?: unknown; minDepositHeight?: unknown };
  if (!Array.isArray(raw.outpoints)) throw new Error(`V2_PRE_CUTOVER_ALLOW ${path}: expected {"outpoints": ["txid:vout", ...]}`);
  const h = raw.minDepositHeight;
  if (h !== undefined && (typeof h !== 'number' || !Number.isInteger(h) || h <= 0)) {
    throw new Error(`V2_PRE_CUTOVER_ALLOW ${path}: minDepositHeight must be a positive integer`);
  }
  return { minDepositHeight: (h as number | undefined) ?? null, outpoints: new Set(raw.outpoints.map((o) => {
    const v = String(o).toLowerCase();
    if (!/^[0-9a-f]{64}:\d+$/.test(v)) throw new Error(`V2_PRE_CUTOVER_ALLOW ${path}: bad outpoint ${String(o)}`);
    return v;
  })) };
}

export function loadConfig(): WatcherConfig {
  const network = (process.env['DOBBSCOIN_NETWORK'] ?? 'mainnet') as 'mainnet' | 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`DOBBSCOIN_NETWORK must be "mainnet" or "testnet", got: ${network}`);
  }

  const version = parseBridgeControllerVersion(process.env['BRIDGE_CONTROLLER_VERSION']);
  // The floor comes from the export's allow file (V2_PRE_CUTOVER_ALLOW). A
  // V2_MIN_DEPOSIT_HEIGHT env, if also set, must agree with it.
  const allow = loadPreCutoverAllow(process.env['V2_PRE_CUTOVER_ALLOW']);
  const envHeight = process.env['V2_MIN_DEPOSIT_HEIGHT'] ? optionalEnvInt('V2_MIN_DEPOSIT_HEIGHT', 0) : null;
  if (envHeight !== null && envHeight <= 0) throw new Error(`V2_MIN_DEPOSIT_HEIGHT must be > 0, got ${envHeight}`);
  if (envHeight !== null && allow.minDepositHeight !== null && envHeight !== allow.minDepositHeight) {
    throw new Error(`V2_MIN_DEPOSIT_HEIGHT=${envHeight} disagrees with the allow file's minDepositHeight ${allow.minDepositHeight}`);
  }
  const v2MinDepositHeight = allow.minDepositHeight ?? envHeight;
  if (version === 2 && (allow.minDepositHeight === null)) {
    throw new Error('BRIDGE_CONTROLLER_VERSION=2 needs V2_PRE_CUTOVER_ALLOW (the export\'s allow file, with minDepositHeight); see docs/v2-cutover.md');
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
    bridgeControllerVersion: version,
    pollIntervalMs:          optionalEnvInt('POLL_INTERVAL_MS', 15_000),
    minConfirmations:        optionalEnvInt('MIN_CONFIRMATIONS', 3),
    finalConfirmations:      optionalEnvInt('FINAL_CONFIRMATIONS', 6),
    dobbscoinNetwork:        network,
    dobbscoinChainId:        DOBBSCOIN_CHAIN_IDS[network],
    reorgDepth:              optionalEnvInt('REORG_DEPTH', 200),
    catchupMaxBlocks:        optionalEnvInt('WATCHER_CATCHUP_MAX_BLOCKS', 2_000),
    hdWalletXpub:            requireEnv('HD_WALLET_XPUB'),
    hdDerivationPath:        process.env['HD_DERIVATION_PATH'] || 'm/0',
    dobbscoinAddressVersion: optionalEnvInt('DOBBSCOIN_ADDRESS_VERSION', 0),
    v2MinDepositHeight,
    v2PreCutoverAllowed:     allow.outpoints,
  };
}
