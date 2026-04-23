import { parseAbi } from 'viem';

// ─── Addresses (set via env vars after deployment) ────────────────────────────

export const WBOB_ADDRESS =
  (process.env.NEXT_PUBLIC_WBOB_ADDRESS ?? '') as `0x${string}`;

export const BRIDGE_CONTROLLER_ADDRESS =
  (process.env.NEXT_PUBLIC_BRIDGE_CONTROLLER_ADDRESS ?? '') as `0x${string}`;

// ─── ABIs ────────────────────────────────────────────────────────────────────

export const WBOB_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

export const BRIDGE_CONTROLLER_ABI = parseAbi([
  'function requestWithdrawal(uint256 amount, string calldata dobbscoinAddress) external',
  'function paused() view returns (bool)',
  'event WithdrawalRequested(uint256 indexed withdrawalId, address indexed sender, uint256 amount, string dobbscoinAddress, uint256 nonce)',
]);

// ─── Inbound progress steps ───────────────────────────────────────────────────

export const INBOUND_STEPS = [
  { state: 'DEPOSIT_ADDRESS_ASSIGNED', label: 'Deposit address ready'   },
  { state: 'DEPOSIT_SEEN_MEMPOOL',     label: 'Deposit detected'         },
  { state: 'DEPOSIT_CONFIRMED',        label: 'Confirming on Dobbscoin'  },
  { state: 'DEPOSIT_FINALIZED',        label: 'Dobbscoin finalized'      },
  { state: 'MINT_AUTH_CREATED',        label: 'Mint authorized'          },
  { state: 'MINT_SUBMITTED',           label: 'Mint submitted to Gnosis' },
  { state: 'COMPLETED',                label: 'wBOB received!'           },
];

// ─── Outbound progress steps ──────────────────────────────────────────────────

export const OUTBOUND_STEPS = [
  { state: 'BURN_TX_SEEN',      label: 'Burn detected on Gnosis'    },
  { state: 'BURN_CONFIRMED',    label: 'Burn confirmed'              },
  { state: 'PAYOUT_QUEUED',     label: 'Payout queued'               },
  { state: 'PAYOUT_SIGNED',     label: 'Payout transaction signed'   },
  { state: 'PAYOUT_BROADCAST',  label: 'Broadcast to Dobbscoin'      },
  { state: 'COMPLETED',         label: 'BOB received!'               },
];

const INBOUND_ORDER = INBOUND_STEPS.map((s) => s.state);
const OUTBOUND_ORDER = OUTBOUND_STEPS.map((s) => s.state);

/** Returns the 0-based index of `state` in the relevant flow, or -1 if not found. */
export function stateIndex(state: string, isOutbound: boolean): number {
  return isOutbound ? OUTBOUND_ORDER.indexOf(state) : INBOUND_ORDER.indexOf(state);
}
