/**
 * Backend configuration — loaded from environment variables.
 * Throws at startup if any required variable is missing.
 */

import type { Hex, Address } from '@wbob/shared';
import { DOBBSCOIN_CHAIN_IDS } from '@wbob/shared';

export interface BackendConfig {
  // ── Solvency monitor (Phase 8) ────────────────────────────────────────────
  /**
   * wBOB ERC-20 address on Gnosis.  When set the monitor reads totalSupply()
   * from chain; when unset it estimates from the DB instead.
   */
  wBobAddress: Address | null;
  /** How often the solvency monitor polls (ms).  Default 5 min. */
  monitorIntervalMs: number;
  /** HTTP endpoint to POST alerts to.  Unset = log only. */
  alertWebhookUrl: string | null;
  /** Minimum interval between repeated alerts of the same type (ms).  Default 1 h. */
  alertCooldownMs: number;
  /**
   * Warn when the available UTXO pool drops below this value (satoshis).
   * Default 100 000 000 (1 BOB).
   */
  lowUtxoThresholdSat: number;
  /**
   * Orders that have not advanced state in this many hours are flagged as stuck.
   * Default 4 h.
   */
  stuckOrderThresholdHours: number;
  /** Postgres connection string. */
  databaseUrl: string;
  /** HTTP port. */
  port: number;
  /** BIP32 extended public key — deposit address derivation (read-only, safe to expose). */
  hdWalletXpub: string;
  /**
   * BIP32 extended PRIVATE key — required for signing Dobbscoin payout transactions.
   * This is the most sensitive secret in the bridge. Store it in a HSM in production.
   */
  hdWalletXpriv: string;
  /** Dobbscoin P2PKH address version byte (0x00 = Bitcoin mainnet compatible). */
  dobbscoinAddressVersion: number;
  /** HD derivation path prefix for deposit addresses. */
  hdDerivationPath: string;
  /** HD derivation path prefix for change addresses (separate from deposit). */
  hdChangePath: string;
  /** Dobbscoin RPC connection. */
  dobbscoinRpc: {
    url: string;
    username: string;
    password: string;
    timeoutMs: number;
  };
  /** Fee rate for Dobbscoin payout transactions (satoshis per vbyte). */
  dobbscoinFeeRateSatPerVbyte: number;
  /** Gnosis mainnet RPC URL. */
  gnosisRpcUrl: string;
  /** Private key of the wallet that pays gas for executeMint (needs xDAI only). */
  executorPrivateKey: Hex;
  /**
   * Deployed BridgeExecutorModule address.
   * When set, the backend can trigger emergency pause/unpause via the module
   * without waiting for a full Safe multisig round-trip.
   * If unset, emergency pause is disabled.
   */
  bridgeExecutorModuleAddress: Address | null;
  /** Deployed BridgeController address on Gnosis. */
  bridgeControllerAddress: Address;
  /** How long mint authorizations are valid from creation (seconds). */
  mintDeadlineSeconds: number;
  /** How often executors poll for new work (ms). */
  executorPollIntervalMs: number;
  /** Gnosis blocks required before a burn is considered confirmed. */
  gnosisConfirmationDepth: number;
  /** Dobbscoin network: mainnet | testnet. */
  dobbscoinNetwork: 'mainnet' | 'testnet';
  /** Derived from dobbscoinNetwork. */
  dobbscoinChainId: bigint;
  /** Source chain name for depositId computation. */
  sourceChainName: string;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnvInt(key: string, def: number): number {
  const val = process.env[key];
  if (!val) return def;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`${key} must be an integer, got: ${val}`);
  return n;
}

export function loadConfig(): BackendConfig {
  const network = (process.env['DOBBSCOIN_NETWORK'] ?? 'mainnet') as 'mainnet' | 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`DOBBSCOIN_NETWORK must be "mainnet" or "testnet", got: ${network}`);
  }

  return {
    databaseUrl:                requireEnv('DATABASE_URL'),
    port:                       optionalEnvInt('PORT', 3000),
    hdWalletXpub:               requireEnv('HD_WALLET_XPUB'),
    hdWalletXpriv:              requireEnv('HD_WALLET_XPRIV'),
    dobbscoinAddressVersion:    optionalEnvInt('DOBBSCOIN_ADDRESS_VERSION', 0x00),
    hdDerivationPath:           process.env['HD_DERIVATION_PATH'] ?? 'm/0',
    hdChangePath:               process.env['HD_CHANGE_PATH'] ?? 'm/1',
    dobbscoinRpc: {
      url:      requireEnv('DOBBSCOIN_RPC_URL'),
      username: requireEnv('DOBBSCOIN_RPC_USER'),
      password: requireEnv('DOBBSCOIN_RPC_PASS'),
      timeoutMs: optionalEnvInt('DOBBSCOIN_RPC_TIMEOUT_MS', 30_000),
    },
    dobbscoinFeeRateSatPerVbyte: optionalEnvInt('DOBBSCOIN_FEE_RATE_SAT_PER_VBYTE', 10),
    gnosisRpcUrl:               requireEnv('GNOSIS_RPC_URL'),
    executorPrivateKey:         requireEnv('EXECUTOR_PRIVATE_KEY') as Hex,
    bridgeControllerAddress:    requireEnv('BRIDGE_CONTROLLER_ADDRESS') as Address,
    bridgeExecutorModuleAddress: (process.env['BRIDGE_EXECUTOR_MODULE_ADDRESS'] ?? null) as Address | null,
    wBobAddress:                (process.env['WBOB_ADDRESS'] ?? null) as Address | null,
    monitorIntervalMs:          optionalEnvInt('MONITOR_INTERVAL_MS', 300_000),
    alertWebhookUrl:            process.env['ALERT_WEBHOOK_URL'] ?? null,
    alertCooldownMs:            optionalEnvInt('ALERT_COOLDOWN_MS', 3_600_000),
    lowUtxoThresholdSat:        optionalEnvInt('LOW_UTXO_THRESHOLD_SAT', 100_000_000),
    stuckOrderThresholdHours:   optionalEnvInt('STUCK_ORDER_THRESHOLD_HOURS', 4),
    mintDeadlineSeconds:        optionalEnvInt('MINT_DEADLINE_SECONDS', 3600),
    executorPollIntervalMs:     optionalEnvInt('EXECUTOR_POLL_INTERVAL_MS', 15_000),
    gnosisConfirmationDepth:    optionalEnvInt('GNOSIS_CONFIRMATION_DEPTH', 12),
    dobbscoinNetwork:           network,
    dobbscoinChainId:           DOBBSCOIN_CHAIN_IDS[network],
    sourceChainName:            `dobbscoin-${network}`,
  };
}
