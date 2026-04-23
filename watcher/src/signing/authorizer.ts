/**
 * MintAuthorization signer.
 *
 * Each watcher holds one EOA private key.  When a deposit reaches
 * DEPOSIT_FINALIZED, the watcher:
 *   1. Constructs a MintAuthorization struct
 *   2. Signs it as EIP-712 typed data
 *   3. Returns the signature for the submitter to store in the DB
 *
 * Uses viem's signTypedData for deterministic ECDSA signing.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { signTypedData } from 'viem/actions';
import { createWalletClient, http } from 'viem';
import { gnosis } from 'viem/chains';
import {
  BRIDGE_CONTROLLER_DOMAIN,
  MINT_AUTHORIZATION_TYPES,
  type MintAuthorization,
  type Address,
  type Hex,
} from '@wbob/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthorizerConfig {
  /** Watcher private key hex (0x-prefixed 32-byte hex). */
  privateKey: Hex;
  /** Address of the deployed BridgeController contract (required for EIP-712 verifyingContract). */
  bridgeControllerAddress: Address;
}

// ─── Authorizer ───────────────────────────────────────────────────────────────

export class MintAuthorizer {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly bridgeControllerAddress: Address;

  constructor(config: AuthorizerConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.bridgeControllerAddress = config.bridgeControllerAddress;
  }

  /** The EOA address corresponding to this watcher's private key. */
  get address(): Address {
    return this.account.address as Address;
  }

  /**
   * Sign a MintAuthorization struct using EIP-712.
   *
   * @returns 65-byte ECDSA signature as 0x-prefixed hex string.
   */
  async sign(auth: MintAuthorization): Promise<Hex> {
    const domain = {
      ...BRIDGE_CONTROLLER_DOMAIN,
      verifyingContract: this.bridgeControllerAddress,
    } as const;

    const message = {
      depositId: auth.depositId as `0x${string}`,
      recipient: auth.recipient as `0x${string}`,
      amount: auth.amount,
      sourceChainId: auth.sourceChainId,
      sourceTxHash: auth.sourceTxHash as `0x${string}`,
      sourceVout: auth.sourceVout,
      deadline: auth.deadline,
      nonce: auth.nonce,
    };

    const signature = await this.account.signTypedData({
      domain,
      types: MINT_AUTHORIZATION_TYPES,
      primaryType: 'MintAuthorization',
      message,
    });

    return signature as Hex;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createAuthorizer(config: AuthorizerConfig): MintAuthorizer {
  return new MintAuthorizer(config);
}
