/**
 * BridgeGuard — Phase 6.
 *
 * Provides programmatic emergency pause/unpause of BridgeController via the
 * BridgeExecutorModule. The executor hot wallet (which owns the module's
 * `operator` slot) calls pause() or unpause() on the module; the module
 * routes the call through the Gnosis Safe, which holds PAUSER_ROLE.
 *
 * This avoids waiting for a full multisig round-trip in emergencies.
 *
 * Usage: call emergencyPause() when a critical anomaly is detected, and
 * emergencyUnpause() once the incident is resolved.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';

const MODULE_ABI = parseAbi([
  'function pause() external',
  'function unpause() external',
  'function operator() view returns (address)',
]);

export class BridgeGuard {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;
  private readonly moduleAddress: ViemHex;

  constructor(private readonly config: BackendConfig) {
    if (!config.bridgeExecutorModuleAddress) {
      throw new Error('BridgeGuard: BRIDGE_EXECUTOR_MODULE_ADDRESS is not configured');
    }

    this.moduleAddress = config.bridgeExecutorModuleAddress as ViemHex;
    this.account = privateKeyToAccount(config.executorPrivateKey as ViemHex);

    this.publicClient = createPublicClient({
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
  }

  /**
   * Pause BridgeController via the module.
   * Logs and swallows errors so callers can fire-and-forget during incident handling.
   */
  async emergencyPause(reason: string): Promise<void> {
    console.error(`[bridge-guard] EMERGENCY PAUSE triggered — reason: ${reason}`);
    try {
      const txHash = await this.walletClient.writeContract({
        address: this.moduleAddress,
        abi: MODULE_ABI,
        functionName: 'pause',
      });
      console.error(`[bridge-guard] pause tx submitted: ${txHash}`);
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      console.error('[bridge-guard] BridgeController PAUSED via module');
    } catch (err) {
      console.error('[bridge-guard] FAILED to pause via module:', err);
    }
  }

  /**
   * Unpause BridgeController via the module.
   * Should only be called after the incident is resolved and humans have reviewed.
   */
  async emergencyUnpause(reason: string): Promise<void> {
    console.log(`[bridge-guard] unpause triggered — reason: ${reason}`);
    try {
      const txHash = await this.walletClient.writeContract({
        address: this.moduleAddress,
        abi: MODULE_ABI,
        functionName: 'unpause',
      });
      console.log(`[bridge-guard] unpause tx submitted: ${txHash}`);
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log('[bridge-guard] BridgeController UNPAUSED via module');
    } catch (err) {
      console.error('[bridge-guard] FAILED to unpause via module:', err);
    }
  }

  /** Returns the current operator address registered on the module. */
  async getOperator(): Promise<string> {
    return this.publicClient.readContract({
      address: this.moduleAddress,
      abi: MODULE_ABI,
      functionName: 'operator',
    }) as Promise<string>;
  }

  /** True if the module is configured (non-null address in config). */
  static isEnabled(config: BackendConfig): boolean {
    return config.bridgeExecutorModuleAddress !== null;
  }
}
