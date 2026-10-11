/**
 * Daily mint cap — how much of a deposit can be minted right now.
 *
 * WBob._checkAndUpdateDailyLimit (contracts/src/WBob.sol):
 *
 *   if (block.timestamp >= currentDayStart + 1 days) {
 *     currentDayMinted = 0;
 *     currentDayStart  = block.timestamp - block.timestamp % 1 days;   // 00:00 UTC
 *   }
 *   if (amount > dailyMintLimit - currentDayMinted) revert ExceedsDailyMintLimit(...)
 *
 * and WBob.mint additionally reverts ExceedsMaxSupply when MAX_SUPPLY > 0 and
 * the mint would pass it.
 *
 * The chain only knows about mints that have executed. Authorizations the
 * bridge has created but not yet executed will consume the same window, so the
 * capacity offered to a new deposit is
 *
 *   min(limit − mintedToday, MAX_SUPPLY − totalSupply) − reserved
 *
 * where `reserved` is the sum of every unexecuted mint the bridge has already
 * committed to. Counting every unexecuted mint (not just today's) is the
 * conservative choice: a reservation left over from yesterday will execute in
 * today's window when it executes at all.
 *
 * Everything in this file except the reader is pure, so the split can be unit
 * tested without a chain or a database.
 */

import { parseAbi, type Hex, type PublicClient } from 'viem';
import type { Sql, TransactionSql } from 'postgres';

export const DAY_SECONDS = 86_400n;

// ─── Chain state ─────────────────────────────────────────────────────────────

export interface MintCapChainState {
  dailyMintLimit:   bigint;
  currentDayMinted: bigint;
  currentDayStart:  bigint;
  /** WBob.MAX_SUPPLY; 0 = uncapped. */
  maxSupply:        bigint;
  totalSupply:      bigint;
  /** Gnosis block the values above were read at. */
  blockNumber:      bigint;
  /** That block's timestamp — the clock the contract will judge "today" by. */
  blockTimestamp:   bigint;
}

export interface MintCapWindow {
  limitSat:          bigint;
  /** Minted in the current window (0 when the on-chain window is stale). */
  mintedTodaySat:    bigint;
  /** limit − minted, further bounded by MAX_SUPPLY room. Never negative. */
  remainingTodaySat: bigint;
  /** True when the on-chain window has expired; the next mint resets it. */
  windowStale:       boolean;
  windowStartSec:    bigint;
  /** When the window rolls over (00:00 UTC for an aligned window). */
  resetsAtSec:       bigint;
}

/**
 * Interpret the on-chain cap state as of `nowSec` (default: the block the
 * state was read at). Using the chain's own clock matters at midnight: the
 * local clock can be past 00:00 while Gnosis blocks are not, and the contract
 * judges by block.timestamp.
 */
export function computeCapWindow(
  state: MintCapChainState,
  nowSec: bigint = state.blockTimestamp,
): MintCapWindow {
  const windowStale = nowSec >= state.currentDayStart + DAY_SECONDS;
  const mintedTodaySat = windowStale ? 0n : state.currentDayMinted;
  const windowStartSec = windowStale ? nowSec - (nowSec % DAY_SECONDS) : state.currentDayStart;

  let remainingTodaySat = state.dailyMintLimit > mintedTodaySat
    ? state.dailyMintLimit - mintedTodaySat
    : 0n;

  if (state.maxSupply > 0n) {
    const room = state.maxSupply > state.totalSupply ? state.maxSupply - state.totalSupply : 0n;
    if (room < remainingTodaySat) remainingTodaySat = room;
  }

  return {
    limitSat: state.dailyMintLimit,
    mintedTodaySat,
    remainingTodaySat,
    windowStale,
    windowStartSec,
    resetsAtSec: windowStartSec + DAY_SECONDS,
  };
}

/** Capacity left for a NEW deposit after the bridge's own unexecuted reservations. */
export function availableCapacity(window: MintCapWindow, reservedSat: bigint): bigint {
  const left = window.remainingTodaySat - reservedSat;
  return left > 0n ? left : 0n;
}

export interface DepositSplit {
  mintSat:   bigint;
  excessSat: bigint;
}

/** mint = min(deposit, max(capacity, 0)); excess = deposit − mint. */
export function splitDeposit(depositSat: bigint, capacitySat: bigint): DepositSplit {
  if (depositSat <= 0n) throw new Error(`splitDeposit: deposit must be positive, got ${depositSat}`);
  const cap = capacitySat > 0n ? capacitySat : 0n;
  const mintSat = depositSat < cap ? depositSat : cap;
  return { mintSat, excessSat: depositSat - mintSat };
}

// ─── Display ─────────────────────────────────────────────────────────────────

const SAT = 100_000_000n;
/** 12345678900000 → "123,456.789" (sat → BOB, thousands separated, trailing zeros trimmed). */
export function fmtBob(sat: bigint): string {
  const neg = sat < 0n;
  const v = neg ? -sat : sat;
  const whole = (v / SAT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (v % SAT).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ─── Reservations ────────────────────────────────────────────────────────────

export interface Reservation {
  amountSat: bigint;
  /** executeMint tx hash if one was sent; null while still collecting signatures. */
  gnosisTxHash: string | null;
}

/**
 * Sum the reservations that the chain state does NOT already include.
 *
 * A reservation whose executeMint was mined at or before the block the cap
 * state was read at is already inside currentDayMinted (or reverted and never
 * will be); counting it again would refund coins that could have been minted.
 * Everything else — unsigned, unsubmitted, or submitted but not yet mined as
 * of that block — is still owed capacity.
 */
export function sumOutstandingReservations(
  reservations: Reservation[],
  minedByStateBlock: ReadonlySet<string>,
): bigint {
  let total = 0n;
  for (const r of reservations) {
    if (r.gnosisTxHash && minedByStateBlock.has(r.gnosisTxHash.toLowerCase())) continue;
    total += r.amountSat;
  }
  return total;
}

/**
 * Sum of the bridge's unexecuted mint commitments that `state` does not
 * already include. Read inside the capacity lock when deciding a split; read
 * without it for display (the API), where a momentary skew is harmless.
 */
export async function outstandingReservedSat(
  db: Sql | TransactionSql,
  reader: MintCapReader,
  state: MintCapChainState,
  excludeOrderId: string | null = null,
): Promise<bigint> {
  const rows = await db<{ order_id: string; amount_sat: bigint; gnosis_tx_hash: string | null }[]>`
    SELECT mr.order_id, mr.amount_sat, mr.gnosis_tx_hash
    FROM mint_requests mr
    JOIN bridge_orders bo ON bo.id = mr.order_id
    WHERE bo.state IN ('MINT_AUTH_CREATED', 'MINT_SUBMITTED')
  `;
  const reservations = rows
    .filter((r) => r.order_id !== excludeOrderId)
    .map((r) => ({ amountSat: r.amount_sat, gnosisTxHash: r.gnosis_tx_hash }));

  const mined = new Set<string>();
  for (const r of reservations) {
    if (r.gnosisTxHash && await reader.minedAtOrBefore(r.gnosisTxHash, state.blockNumber)) {
      mined.add(r.gnosisTxHash.toLowerCase());
    }
  }
  return sumOutstandingReservations(reservations, mined);
}

// ─── Reader ──────────────────────────────────────────────────────────────────

export interface MintCapReader {
  readState(): Promise<MintCapChainState>;
  /** True if `txHash` is in a block at or below `blockNumber` (success or revert). */
  minedAtOrBefore(txHash: string, blockNumber: bigint): Promise<boolean>;
}

export const WBOB_CAP_ABI = parseAbi([
  'function dailyMintLimit() view returns (uint256)',
  'function currentDayMinted() view returns (uint256)',
  'function currentDayStart() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);

const CONTROLLER_WBOB_ABI = parseAbi(['function wBOB() view returns (address)']);

/**
 * Reads the cap from the wBOB contract, all values pinned to one block so they
 * are mutually consistent. If the wBOB address is not configured it is read
 * from BridgeController.wBOB() (immutable) once and cached.
 */
export class ViemMintCapReader implements MintCapReader {
  private wBobAddress: Hex | null;

  constructor(
    private readonly client: PublicClient,
    wBobAddress: string | null,
    private readonly bridgeControllerAddress: string,
  ) {
    this.wBobAddress = (wBobAddress as Hex | null) ?? null;
  }

  private async token(): Promise<Hex> {
    if (!this.wBobAddress) {
      this.wBobAddress = await this.client.readContract({
        address: this.bridgeControllerAddress as Hex,
        abi: CONTROLLER_WBOB_ABI,
        functionName: 'wBOB',
      }) as Hex;
    }
    return this.wBobAddress;
  }

  async readState(): Promise<MintCapChainState> {
    const address = await this.token();
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const blockNumber = block.number;
    if (blockNumber === null) throw new Error('latest block has no number');
    const read = (functionName: 'dailyMintLimit' | 'currentDayMinted' | 'currentDayStart' | 'MAX_SUPPLY' | 'totalSupply') =>
      this.client.readContract({ address, abi: WBOB_CAP_ABI, functionName, blockNumber }) as Promise<bigint>;
    const [dailyMintLimit, currentDayMinted, currentDayStart, maxSupply, totalSupply] = await Promise.all([
      read('dailyMintLimit'),
      read('currentDayMinted'),
      read('currentDayStart'),
      read('MAX_SUPPLY'),
      read('totalSupply'),
    ]);
    return {
      dailyMintLimit, currentDayMinted, currentDayStart, maxSupply, totalSupply,
      blockNumber, blockTimestamp: block.timestamp,
    };
  }

  async minedAtOrBefore(txHash: string, blockNumber: bigint): Promise<boolean> {
    const receipt = await this.client
      .getTransactionReceipt({ hash: txHash as Hex })
      .catch(() => null);
    return receipt !== null && receipt.blockNumber <= blockNumber;
  }
}
