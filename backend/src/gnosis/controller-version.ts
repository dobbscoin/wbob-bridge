/**
 * Startup checks for the controller configuration. Refuses to start on a
 * definite misconfiguration; an RPC failure only warns.
 *
 *  - BRIDGE_CONTROLLER_VERSION must match the contract at BRIDGE_CONTROLLER_ADDRESS
 *    (probe: remainingMintCapacity() exists only on BridgeControllerV2). A mismatch
 *    is silent otherwise: the wrong EIP-712 domain makes every signature fail, and
 *    V1 settings against V2 skip the rolling-cap read and the outpoint check.
 *  - V2 mode needs LEGACY_BRIDGE_CONTROLLER_ADDRESSES (the old controller): one
 *    watermark covers all scanned controllers, so a V1 burn still below it at the
 *    switch would otherwise never be ingested (burned, never paid).
 *  - V2's on-chain minWithdrawal should be >= PAYOUT_MIN_SAT, or burns between the
 *    two are accepted on-chain and then parked by the payout executor.
 */
import {
  createPublicClient, http, fallback, parseAbi,
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex,
} from 'viem';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';

const PROBE_ABI = parseAbi([
  'function remainingMintCapacity() view returns (uint256)',
  'function minWithdrawal() view returns (uint256)',
  'function processedDeposits(bytes32) view returns (bool)',
]);

/**
 * 2 if the contract answers a V2-only view, 1 if it REVERTS or returns no data.
 * Anything else (HTTP error, timeout) is rethrown: viem wraps every failure in
 * ContractFunctionExecutionError, so the class name alone proves nothing; the
 * cause chain says whether the CONTRACT refused.
 */
export async function detectControllerVersion(
  client: { readContract: (a: never) => Promise<unknown> },
  address: string,
): Promise<1 | 2> {
  try {
    await client.readContract({ address: address as Hex, abi: PROBE_ABI, functionName: 'remainingMintCapacity' } as never);
    return 2;
  } catch (err) {
    if (err instanceof BaseError) {
      const cause = err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
      if (cause) return 1;
    }
    throw err;
  }
}

export async function assertControllerVersion(config: BackendConfig): Promise<void> {
  if (config.bridgeControllerVersion === 2 && (config.legacyBridgeControllerAddresses ?? []).length === 0) {
    throw new Error(
      'BRIDGE_CONTROLLER_VERSION=2 needs LEGACY_BRIDGE_CONTROLLER_ADDRESSES=<V1 controller>: without it, V1 burns ' +
      'below the scan watermark at the switch are never ingested. (It is harmless to keep set afterwards.)',
    );
  }
  const client = createPublicClient({ chain: gnosis, transport: fallback(config.gnosisRpcUrls.map((u) => http(u))) });
  let onChain: 1 | 2;
  try {
    onChain = await detectControllerVersion(client as never, config.bridgeControllerAddress);
  } catch (err) {
    console.warn(`[backend] could not verify the controller version (RPC): ${String(err).slice(0, 160)}`);
    return;
  }
  if (onChain !== config.bridgeControllerVersion) {
    throw new Error(
      `BRIDGE_CONTROLLER_VERSION=${config.bridgeControllerVersion} but ${config.bridgeControllerAddress} is a ` +
      `V${onChain} controller. Fix .env for the backend AND every watcher before starting.`,
    );
  }
  console.log(`[backend] controller ${config.bridgeControllerAddress} verified as V${onChain}`);

  // Every legacy address must BE a controller: the executor asks each one
  // "already minted?" before authorizing; a wrong address would stall every
  // authorization with console output only.
  for (const legacy of config.legacyBridgeControllerAddresses ?? []) {
    try {
      await client.readContract({
        address: legacy as Hex, abi: PROBE_ABI, functionName: 'processedDeposits', args: [`0x${'00'.repeat(32)}`],
      });
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) {
        throw new Error(`LEGACY_BRIDGE_CONTROLLER_ADDRESSES entry ${legacy} is not a bridge controller (no processedDeposits).`);
      }
      console.warn(`[backend] could not probe legacy controller ${legacy} (RPC): ${String(err).slice(0, 120)}`);
    }
  }
  if (onChain === 2) {
    try {
      const minW = await client.readContract({
        address: config.bridgeControllerAddress as Hex, abi: PROBE_ABI, functionName: 'minWithdrawal',
      }) as bigint;
      if (minW < config.payoutMinSat) {
        console.error(`[backend] V2 minWithdrawal ${minW} < PAYOUT_MIN_SAT ${config.payoutMinSat}: burns between the two ` +
          `are accepted on-chain and then parked in MANUAL_REVIEW. Raise it with setMinWithdrawal via the Safe.`);
      }
    } catch (err) {
      console.warn(`[backend] could not read V2 minWithdrawal: ${String(err).slice(0, 120)}`);
    }
  }
}
