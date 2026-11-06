/**
 * Refuse to start when BRIDGE_CONTROLLER_VERSION does not match the contract at
 * BRIDGE_CONTROLLER_ADDRESS. A mismatch is silent otherwise: the wrong EIP-712
 * domain makes every signature fail (mints stall), and V1 settings against V2
 * skip the rolling-cap read and the outpoint replay check.
 *
 * Probe: remainingMintCapacity() exists only on BridgeControllerV2.
 */
import { createPublicClient, http, fallback, parseAbi, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import type { BackendConfig } from '../config.js';

const PROBE_ABI = parseAbi(['function remainingMintCapacity() view returns (uint256)']);

export async function detectControllerVersion(
  client: { readContract: (a: never) => Promise<unknown> },
  address: string,
): Promise<1 | 2> {
  try {
    await client.readContract({ address: address as Hex, abi: PROBE_ABI, functionName: 'remainingMintCapacity' } as never);
    return 2;
  } catch (err) {
    const msg = String(err);
    // A revert / missing selector means "not V2". Anything else (RPC down) is rethrown.
    if (/revert|execution reverted|returned no data|ContractFunctionExecutionError|function selector/i.test(msg)) return 1;
    throw err;
  }
}

export async function assertControllerVersion(config: BackendConfig): Promise<void> {
  const client = createPublicClient({ chain: gnosis, transport: fallback(config.gnosisRpcUrls.map((u) => http(u))) });
  let onChain: 1 | 2;
  try {
    onChain = await detectControllerVersion(client as never, config.bridgeControllerAddress);
  } catch (err) {
    // RPC unreachable: don't take the backend down over the check itself.
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
}
