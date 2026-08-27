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

  /**
   * Minutes without a new Dobbscoin block before the chain is called stalled.
   * (BOB) has a single miner, so production stops when he stops -- and every
   * in-flight deposit stops confirming with it. Normal spacing is ~2 minutes.
   */
  chainStallThresholdMinutes: number;
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
  /**
   * Single Gnosis RPC endpoint — the WRITE/signing path (executeMint, gas drip,
   * emergency pause/unpause) is pinned to this. Equals gnosisRpcUrls[0] (the
   * preferred self-hosted node). Pinned, not fallback(), to avoid splitting
   * nonce derivation across endpoints with divergent mempools. See
   * gnosis-rpc-fallback-v1.
   */
  gnosisRpcUrl: string;
  /**
   * Ordered Gnosis RPC fallback list, preferred node first (public RPC after).
   * The READ path (solvency monitor, event watcher, balance/receipt reads)
   * wraps these in viem fallback() so chain reads survive the node going down.
   * NOTE: entries past [0] may be non-archive public endpoints — deep-history
   * reads must NOT ride this list (see questions-still-open.md Q28).
   */
  gnosisRpcUrls: string[];
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
  /**
   * Max blocks per `eth_getLogs` window when scanning Gnosis history.
   * Bounds the watcher's catch-up batch size to whatever the upstream RPC
   * accepts. Default 1000 matches our self-hosted Erigon node's server limit.
   */
  gnosisLogScanChunk: number;
  /**
   * Consecutive halted polls before the solvency monitor raises a
   * GNOSIS_SCAN_HALTED alert. The watcher writes halt-state into bridge_state
   * on every failed scan; the monitor observes that state on its own cadence.
   * Default 10 ≈ 2.5 min of halt at the 15s executor poll interval.
   */
  gnosisScanHaltAlertThreshold: number;
  /** Dobbscoin network: mainnet | testnet. */
  dobbscoinNetwork: 'mainnet' | 'testnet';
  /** Derived from dobbscoinNetwork. */
  dobbscoinChainId: bigint;
  /** Source chain name for depositId computation. */
  sourceChainName: string;

  // ── Gas drip (Option 2 onboarding) ────────────────────────────────────────
  /** Master switch — when false, no drips ever, no wallet config required. */
  dripEnabled: boolean;
  /**
   * Drip hot-wallet private key. Separate EOA from the executor.
   * Required when dripEnabled=true; otherwise unused.
   */
  dripHotWalletPrivateKey: Hex | null;
  /** Drip amount in wei. Default 5e16 = 0.05 xDAI. */
  dripAmountWei: bigint;
  /** Minimum bridged amount (sat) to qualify for a drip. Default 1_000_000 = 0.01 BOB. */
  dripMinDepositSat: bigint;
  /** Drip wallet balance (wei) below which the monitor pages ops. Default 1e18 = 1 xDAI. */
  dripLowWaterMarkWei: bigint;
  /** Email recipient for ops alerts (drip wallet low, etc.). Sent via local sendmail. */
  alertEmailTo: string | null;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

/**
 * Parse the ordered Gnosis RPC fallback list.
 *
 * Prefers the new comma-separated GNOSIS_RPC_URLS (node first, public after).
 * Falls back to the legacy single GNOSIS_RPC_URL so existing deployments keep
 * working if the new var is unset. Order is preserved and load-bearing:
 * index 0 is the preferred endpoint and is what the write/signing path pins to.
 */
export function parseGnosisRpcUrls(): string[] {
  const multi = process.env['GNOSIS_RPC_URLS'];
  if (multi && multi.trim()) {
    const urls = multi
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (urls.length === 0) {
      throw new Error('GNOSIS_RPC_URLS is set but contains no usable URLs');
    }
    return urls;
  }
  // Back-compat: no GNOSIS_RPC_URLS → use the legacy single endpoint.
  return [requireEnv('GNOSIS_RPC_URL')];
}

function optionalEnvInt(key: string, def: number): number {
  const val = process.env[key];
  if (!val) return def;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`${key} must be an integer, got: ${val}`);
  return n;
}

function optionalEnvBool(key: string, def: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return def;
  return val.toLowerCase() === 'true' || val === '1';
}

function optionalEnvBigInt(key: string, def: bigint): bigint {
  const val = process.env[key];
  if (!val) return def;
  try {
    return BigInt(val);
  } catch {
    throw new Error(`${key} must be a base-10 integer, got: ${val}`);
  }
}

export function loadConfig(): BackendConfig {
  const network = (process.env['DOBBSCOIN_NETWORK'] ?? 'mainnet') as 'mainnet' | 'testnet';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`DOBBSCOIN_NETWORK must be "mainnet" or "testnet", got: ${network}`);
  }

  // Ordered Gnosis RPC list (node first). gnosisRpcUrls[0] is the preferred
  // endpoint the write/signing path pins to; the full list feeds the read-path
  // fallback().
  const gnosisRpcUrls = parseGnosisRpcUrls();

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
    gnosisRpcUrl:               gnosisRpcUrls[0]!,
    gnosisRpcUrls,
    executorPrivateKey:         requireEnv('EXECUTOR_PRIVATE_KEY') as Hex,
    bridgeControllerAddress:    requireEnv('BRIDGE_CONTROLLER_ADDRESS') as Address,
    bridgeExecutorModuleAddress: (process.env['BRIDGE_EXECUTOR_MODULE_ADDRESS'] ?? null) as Address | null,
    wBobAddress:                (process.env['WBOB_ADDRESS'] ?? null) as Address | null,
    monitorIntervalMs:          optionalEnvInt('MONITOR_INTERVAL_MS', 300_000),
    alertWebhookUrl:            process.env['ALERT_WEBHOOK_URL'] ?? null,
    alertCooldownMs:            optionalEnvInt('ALERT_COOLDOWN_MS', 3_600_000),
    lowUtxoThresholdSat:        optionalEnvInt('LOW_UTXO_THRESHOLD_SAT', 100_000_000),
    stuckOrderThresholdHours:   optionalEnvInt('STUCK_ORDER_THRESHOLD_HOURS', 4),
    chainStallThresholdMinutes: optionalEnvInt('CHAIN_STALL_THRESHOLD_MINUTES', 30),
    mintDeadlineSeconds:        optionalEnvInt('MINT_DEADLINE_SECONDS', 3600),
    executorPollIntervalMs:     optionalEnvInt('EXECUTOR_POLL_INTERVAL_MS', 15_000),
    gnosisConfirmationDepth:    optionalEnvInt('GNOSIS_CONFIRMATION_DEPTH', 12),
    gnosisLogScanChunk:         optionalEnvInt('GNOSIS_LOG_SCAN_CHUNK', 1000),
    gnosisScanHaltAlertThreshold: optionalEnvInt('GNOSIS_SCAN_HALT_ALERT_THRESHOLD', 10),
    dobbscoinNetwork:           network,
    dobbscoinChainId:           DOBBSCOIN_CHAIN_IDS[network],
    sourceChainName:            `dobbscoin-${network}`,

    dripEnabled:                optionalEnvBool('DRIP_ENABLED', false),
    dripHotWalletPrivateKey:    (process.env['DRIP_HOT_WALLET_PRIVATE_KEY'] ?? null) as Hex | null,
    dripAmountWei:              optionalEnvBigInt('DRIP_AMOUNT_WEI', 50_000_000_000_000_000n),
    dripMinDepositSat:          optionalEnvBigInt('DRIP_MIN_DEPOSIT_SAT', 1_000_000n),
    dripLowWaterMarkWei:        optionalEnvBigInt('DRIP_LOW_WATER_MARK_WEI', 1_000_000_000_000_000_000n),
    alertEmailTo:               process.env['ALERT_EMAIL_TO'] ?? null,
  };
}
