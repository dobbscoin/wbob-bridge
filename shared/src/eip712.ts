/**
 * EIP-712 domain and type definitions for BridgeController.
 *
 * These constants mirror BridgeController.sol exactly.  Any change to the
 * Solidity struct or domain must be reflected here and vice versa.
 */

// ─── Domain ───────────────────────────────────────────────────────────────────

/**
 * BridgeController (V1, deployed 2026-05) signs under version '1';
 * BridgeControllerV2 under version '2'. The struct is identical in both.
 * The domain also binds verifyingContract, so a signature for one controller
 * can never be replayed on the other.
 */
export type BridgeControllerVersion = 1 | 2;

export function bridgeControllerDomain(version: BridgeControllerVersion) {
  return {
    name:    'BridgeController',
    version: version === 2 ? '2' : '1',
    chainId: 100, // Gnosis mainnet
  } as const;
}

/** V1 domain (kept for existing callers; prefer bridgeControllerDomain(version)). */
export const BRIDGE_CONTROLLER_DOMAIN = bridgeControllerDomain(1);

/** Read BRIDGE_CONTROLLER_VERSION ('1' default | '2'); throws on anything else. */
export function parseBridgeControllerVersion(raw: string | undefined): BridgeControllerVersion {
  if (raw === undefined || raw === '' || raw === '1') return 1;
  if (raw === '2') return 2;
  throw new Error(`BRIDGE_CONTROLLER_VERSION must be 1 or 2, got: ${raw}`);
}

// ─── Type definitions (EIP-712 typed data) ────────────────────────────────────

export const MINT_AUTHORIZATION_TYPE = [
  { name: 'depositId',     type: 'bytes32'  },
  { name: 'recipient',     type: 'address'  },
  { name: 'amount',        type: 'uint256'  },
  { name: 'sourceChainId', type: 'uint256'  },
  { name: 'sourceTxHash',  type: 'bytes32'  },
  { name: 'sourceVout',    type: 'uint32'   },
  { name: 'deadline',      type: 'uint256'  },
  { name: 'nonce',         type: 'uint256'  },
] as const;

export const MINT_AUTHORIZATION_TYPES = {
  MintAuthorization: MINT_AUTHORIZATION_TYPE,
} as const;

/**
 * Type hash — equals MINT_AUTHORIZATION_TYPEHASH in BridgeController.sol and
 * BridgeControllerV2.sol (same struct):
 *
 * keccak256("MintAuthorization(bytes32 depositId,address recipient,uint256 amount,"
 *           "uint256 sourceChainId,bytes32 sourceTxHash,uint32 sourceVout,"
 *           "uint256 deadline,uint256 nonce)")
 *
 * (The previous constant here was 63 hex chars and not this hash.) Digests are
 * still computed at runtime from domain + struct; this is for cross-checks.
 */
export const MINT_AUTHORIZATION_TYPEHASH =
  '0xe9a8fb1f12f30a50b81623dfdc4d902d18972dd0ed0eaf0b99f74c7d40f8a812' as const;

// ─── Dobbscoin chain identifiers ─────────────────────────────────────────────

export const DOBBSCOIN_CHAIN_IDS = {
  mainnet: 1_000_001n,
  testnet: 1_000_002n,
} as const;

export type DobbscoinNetwork = keyof typeof DOBBSCOIN_CHAIN_IDS;
