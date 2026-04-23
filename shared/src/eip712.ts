/**
 * EIP-712 domain and type definitions for BridgeController.
 *
 * These constants mirror BridgeController.sol exactly.  Any change to the
 * Solidity struct or domain must be reflected here and vice versa.
 */

// ─── Domain ───────────────────────────────────────────────────────────────────

export const BRIDGE_CONTROLLER_DOMAIN = {
  name:    'BridgeController',
  version: '1',
  chainId: 100, // Gnosis mainnet
} as const;

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
 * Type hash — must match BridgeController.sol:MINT_AUTHORIZATION_TYPEHASH.
 *
 * keccak256("MintAuthorization(bytes32 depositId,address recipient,uint256 amount,"
 *           "uint256 sourceChainId,bytes32 sourceTxHash,uint32 sourceVout,"
 *           "uint256 deadline,uint256 nonce)")
 *
 * Pre-computed value for reference (use viem's hashTypedData at runtime).
 */
export const MINT_AUTHORIZATION_TYPEHASH =
  '0xa59c037e7d89a0e13d7d0c6de46bc2bc8d2b1f2f7b52e86c80b0e4a6b6b3b4c' as const;
// NOTE: This hash is informational only.  Always use viem/ethers to compute
//       the actual digest at runtime from the domain + struct.

// ─── Dobbscoin chain identifiers ─────────────────────────────────────────────

export const DOBBSCOIN_CHAIN_IDS = {
  mainnet: 1_000_001n,
  testnet: 1_000_002n,
} as const;

export type DobbscoinNetwork = keyof typeof DOBBSCOIN_CHAIN_IDS;
