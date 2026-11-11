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
 *
 * V2 (BRIDGE_CONTROLLER_VERSION=2): the module is EmergencyPauseModule. Its one
 * call, pauseAll(), pauses the controller AND the wBOB token. It has no unpause:
 * unpausing is a Safe transaction, so emergencyUnpause() refuses. The operator
 * key is EMERGENCY_OPERATOR_PRIVATE_KEY (falls back to the executor key, with a
 * warning: a key that can freeze the token should not be the relayer hot key).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  parseEventLogs,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';
import { AlertDispatcher } from '../monitor/webhook.js';

const MODULE_EVENTS_ABI = parseAbi([
  'event EmergencyPaused(address indexed triggeredBy, bool controllerPaused, bool tokenPaused)',
  'event PauseFailed(address indexed target)',
]);

const MODULE_ABI = parseAbi([
  'function pause() external',
  'function unpause() external',
  'function pauseAll() external',
  'function operator() view returns (address)',
  'function safe() view returns (address)',
  'function controller() view returns (address)',
  'function token() view returns (address)',
]);

const SAFE_ABI = parseAbi(['function isModuleEnabled(address module) view returns (bool)']);

export class BridgeGuard {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;
  private readonly moduleAddress: ViemHex;
  private readonly v2: boolean;

  constructor(private readonly config: BackendConfig) {
    // (config is kept: readiness() compares the module's targets with it.)
    if (!config.bridgeExecutorModuleAddress) {
      throw new Error('BridgeGuard: BRIDGE_EXECUTOR_MODULE_ADDRESS is not configured');
    }

    this.moduleAddress = config.bridgeExecutorModuleAddress as ViemHex;
    this.v2 = config.bridgeControllerVersion === 2;
    if (this.v2 && !config.emergencyOperatorPrivateKey) {
      console.warn('[bridge-guard] EMERGENCY_OPERATOR_PRIVATE_KEY unset: using the executor key for a module that can freeze the token');
    }
    // The separate key belongs to V2's module only. On V1 the module operator
    // is the executor key, so staging EMERGENCY_OPERATOR_PRIVATE_KEY early must
    // not change V1's pause.
    this.account = privateKeyToAccount(
      ((this.v2 ? config.emergencyOperatorPrivateKey : null) ?? config.executorPrivateKey) as ViemHex,
    );

    this.publicClient = createPublicClient({
      chain: gnosis,
      // READ path: fallback() across the ordered RPC list so reads survive the
      // node going down. Writers stay pinned to gnosisRpcUrl — see config.ts.
      transport: fallback(config.gnosisRpcUrls.map((u) => http(u))),
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
        functionName: this.v2 ? 'pauseAll' : 'pause',
      });
      console.error(`[bridge-guard] pause tx submitted: ${txHash}`);
      const rc = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (rc.status !== 'success') {
        console.error(`[bridge-guard] PAUSE TX REVERTED (${txHash}): nothing was paused. Pause via the Safe NOW.`);
        await this._alert(`Emergency pause tx REVERTED (${txHash}); nothing was paused. Pause via the Safe NOW. Reason: ${reason}`);
        return;
      }
      if (!this.v2) {
        console.error('[bridge-guard] BridgeController PAUSED via module');
        return;
      }
      const events = parseEventLogs({ abi: MODULE_EVENTS_ABI, logs: rc.logs });
      const done = events.find((e) => e.eventName === 'EmergencyPaused')?.args as
        { controllerPaused: boolean; tokenPaused: boolean } | undefined;
      const failed = events.filter((e) => e.eventName === 'PauseFailed').map((e) => (e.args as { target: string }).target);
      if (done?.controllerPaused && done?.tokenPaused) {
        console.error('[bridge-guard] BridgeControllerV2 + wBOB token PAUSED via module');
      } else {
        const msg = `PARTIAL PAUSE: controller=${done?.controllerPaused ?? '?'} token=${done?.tokenPaused ?? '?'}` +
          ` failed=[${failed.join(', ')}]. Pause the rest via the Safe NOW.`;
        console.error(`[bridge-guard] ${msg}`);
        await this._alert(`${msg} Reason: ${reason}`);
      }
    } catch (err) {
      console.error('[bridge-guard] FAILED to pause via module:', err);
      await this._alert(`Emergency pause FAILED to send: ${String(err).slice(0, 200)}. Pause via the Safe NOW. Reason: ${reason}`);
    }
  }

  private async _alert(message: string): Promise<void> {
    try {
      await new AlertDispatcher({ webhookUrl: this.config.alertWebhookUrl, emailTo: this.config.alertEmailTo }).dispatch({
        level: 'critical', type: 'MINT_SUBMIT_BLOCKED', timestamp: new Date().toISOString(), message, data: {},
      });
    } catch (err) {
      console.error('[bridge-guard] alert dispatch failed:', err);
    }
  }

  /**
   * Unpause BridgeController via the module.
   * Should only be called after the incident is resolved and humans have reviewed.
   */
  async emergencyUnpause(reason: string): Promise<void> {
    console.log(`[bridge-guard] unpause triggered — reason: ${reason}`);
    if (this.v2) {
      console.error('[bridge-guard] refusing: V2 has no module unpause. Unpause the controller and the token ' +
        'with a Safe transaction (after setOperator/disableModule if the operator key is suspect).');
      return;
    }
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

  /**
   * Startup check: the module's operator must be the key we hold, and it needs
   * xDAI for gas. Returns problems (empty = ready); never throws.
   */
  async readiness(): Promise<string[]> {
    const problems: string[] = [];
    const read = (functionName: 'safe' | 'controller' | 'token') =>
      this.publicClient.readContract({ address: this.moduleAddress, abi: MODULE_ABI, functionName }) as Promise<string>;
    try {
      if (this.v2) {
        // The V1 module has none of these; a V2 config left pointing at it fails here, not mid-incident.
        const [safe, controller, token] = await Promise.all([read('safe'), read('controller'), read('token')]);
        if (controller.toLowerCase() !== this.config.bridgeControllerAddress.toLowerCase()) {
          problems.push(`module controller() is ${controller}, not BRIDGE_CONTROLLER_ADDRESS ${this.config.bridgeControllerAddress}`);
        }
        if (this.config.wBobAddress && token.toLowerCase() !== this.config.wBobAddress.toLowerCase()) {
          problems.push(`module token() is ${token}, not WBOB_ADDRESS ${this.config.wBobAddress}`);
        }
        const enabled = await this.publicClient.readContract({
          address: safe as ViemHex, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [this.moduleAddress],
        }) as boolean;
        if (!enabled) problems.push(`module ${this.moduleAddress} is NOT enabled on Safe ${safe}: pauseAll would revert`);
      }
      const op = (await this.getOperator()).toLowerCase();
      if (op !== this.account.address.toLowerCase()) {
        problems.push(`module operator is ${op} but this backend holds ${this.account.address}: a pause would revert OnlyOperator`);
      }
      const bal = await this.publicClient.getBalance({ address: this.account.address });
      if (bal === 0n) problems.push(`operator ${this.account.address} has 0 xDAI: a pause cannot pay gas`);
    } catch (err) {
      problems.push(this.v2
        ? `could not read the module as an EmergencyPauseModule (is BRIDGE_EXECUTOR_MODULE_ADDRESS still the V1 module?): ${String(err).slice(0, 160)}`
        : `could not read module/operator: ${String(err).slice(0, 160)}`);
    }
    return problems;
  }

  /** True if the module is configured (non-null address in config). */
  static isEnabled(config: BackendConfig): boolean {
    return config.bridgeExecutorModuleAddress !== null;
  }
}
