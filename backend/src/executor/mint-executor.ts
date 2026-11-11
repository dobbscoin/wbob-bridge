/**
 * Mint executor.
 *
 * Jobs, in poll order:
 *
 * Job 3 — Confirmer (runs first so a mint that just landed is out of the
 *   reservation sum before Job 1 sizes the next deposit):
 *   MINT_SUBMITTED → MINT_CONFIRMED → COMPLETED once the executeMint receipt is in.
 *
 * Job 0 — Regenerator:
 *   A MINT_AUTH_CREATED authorization that has passed (or is about to pass) its
 *   deadline unminted, or carries a stale mintNonce, is reissued: fresh
 *   deadline, current nonce, signatures cleared so the watchers re-sign. The
 *   decided mint amount is kept.
 *
 * Job 1 — Auth creator + daily-cap split:
 *   For each DEPOSIT_FINALIZED order, under a global advisory lock, reads the
 *   wBOB daily cap and subtracts every mint the bridge has already committed
 *   to but not executed. Mints min(deposit, capacity); the excess becomes a
 *   deposit_refunds row that the refund executor pays back to the sender.
 *   Nothing left under the cap → the order goes straight to REFUNDED.
 *
 * Job 2 — Mint submitter:
 *   For MINT_AUTH_CREATED with ≥ THRESHOLD signatures: verifies each signature
 *   locally (drops ones that do not recover to their signer, e.g. signed over a
 *   since-regenerated deadline), simulates executeMint, and only then sends it.
 *   A simulated revert is recorded on the mint_request and alerted once per
 *   distinct reason — never retried blindly into the same revert.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  recoverTypedDataAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { Sql, TransactionSql } from 'postgres';
import {
  InboundState,
  assertInboundTransition,
  bridgeControllerDomain,
  mintAuthorizationTypes,
} from '@wbob/shared';
import { bufferToHex } from '../db/hex.js';
import { withRelayerLock } from '../gnosis/relayer-lock.js';
import type { BackendConfig } from '../config.js';
import type { DripSender } from './drip-sender.js';
import { AlertDispatcher } from '../monitor/webhook.js';
import type { Alert } from '../monitor/types.js';
import { isRefundTooSmall } from '../dobbscoin/tx-builder.js';
import {
  ViemMintCapReader,
  availableCapacity,
  computeCapWindow,
  splitDeposit,
  outstandingReservedSat,
  fmtBob,
  type MintCapReader,
  type MintCapChainState,
  type MintCapWindow,
} from './mint-capacity.js';

export { fmtBob };

// ─── ABI ─────────────────────────────────────────────────────────────────────

export const BRIDGE_ABI = parseAbi([
  'function mintNonce() view returns (uint256)',
  'function processedDeposits(bytes32) view returns (bool)',
  'function isSigner(address) view returns (bool)',
  'function executeMint((bytes32 depositId, address recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout, uint256 deadline, uint256 nonce) auth, bytes[] signatures) external',
  // BridgeController
  'error AlreadyProcessed(bytes32 depositId)',
  'error DeadlineExpired(uint256 deadline, uint256 blockTimestamp)',
  'error WrongMintNonce(uint256 provided, uint256 expected)',
  'error InsufficientValidSignatures(uint256 valid, uint8 threshold)',
  // BridgeControllerV2
  'function processedOutpoints(bytes32) view returns (bool)',
  'error OutpointAlreadyMinted(bytes32 outpointKey)',
  'error ExceedsWindowLimit(uint256 requested, uint256 remaining)',
  'error ImportNotSealed()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  // WBob.mint, bubbled up through executeMint
  'error ExceedsDailyMintLimit(uint256 requested, uint256 remaining)',
  'error ExceedsMaxSupply(uint256 requested, uint256 available)',
  // OpenZeppelin v5 Pausable
  'error EnforcedPause()',
  // OpenZeppelin v5 AccessControl (e.g. the controller lacks BRIDGE_EXECUTOR_ROLE on WBob)
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
]);

/**
 * BridgeControllerV2: its executeMint struct adds sourceValue (so it is a
 * different function selector), plus V2-only errors. Picked by version, never
 * by overload resolution.
 */
export const BRIDGE_ABI_V2 = parseAbi([
  'function mintNonce() view returns (uint256)',
  'function processedDeposits(bytes32) view returns (bool)',
  'function processedOutpoints(bytes32) view returns (bool)',
  'function isSigner(address) view returns (bool)',
  'function executeMint((bytes32 depositId, address recipient, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout, uint256 sourceValue, uint256 deadline, uint256 nonce) auth, bytes[] signatures) external',
  'error AlreadyProcessed(bytes32 depositId)',
  'error DeadlineExpired(uint256 deadline, uint256 blockTimestamp)',
  'error WrongMintNonce(uint256 provided, uint256 expected)',
  'error InsufficientValidSignatures(uint256 valid, uint8 threshold)',
  'error OutpointAlreadyMinted(bytes32 outpointKey)',
  'error ExceedsWindowLimit(uint256 requested, uint256 remaining)',
  'error ImportNotSealed()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  'error WrongSourceChain(uint256 provided, uint256 expected)',
  'error SourceValueMismatch(bytes32 outpointKey, uint256 provided, uint256 recorded)',
  'error ExceedsSourceValue(bytes32 outpointKey, uint256 minted, uint256 refunded, uint256 value)',
  'error ExceedsDailyMintLimit(uint256 requested, uint256 remaining)',
  'error ExceedsMaxSupply(uint256 requested, uint256 available)',
  'error EnforcedPause()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
]);

/** The V1 struct has no sourceValue; drop it before hashing under V1 types. */
function stripSourceValue<T extends { sourceValue?: bigint }>(auth: T): Omit<T, 'sourceValue'> {
  const { sourceValue: _drop, ...rest } = auth;
  return rest;
}

/** Reverts that need a human now: the mint will never go through on its own. */
const CRITICAL_REVERTS = new Set([
  'AlreadyProcessed', 'OutpointAlreadyMinted', 'ImportNotSealed', 'WrongSourceChain',
  'SourceValueMismatch', 'ExceedsSourceValue', 'AccessControlUnauthorizedAccount',
]);

const SIGNATURE_THRESHOLD = 3;

/**
 * An authorization this close to its deadline is not submitted (the tx could
 * land after it) and is regenerated instead. Gnosis blocks are ~5 s.
 */
export const DEADLINE_MARGIN_SECONDS = 60n;

/** pg_advisory_xact_lock key serialising every read-decide-reserve of mint capacity. */
export const MINT_CAPACITY_LOCK_KEY = 0x77424f42; // 'wBOB'

// ─── DB row types ─────────────────────────────────────────────────────────────

interface FinalizedOrderRow {
  order_id:           string;
  deposit_id:         Buffer;
  user_gnosis_address: string;
  amount_sat:         bigint;
  txid:               string;
  vout:               number;
  source_chain_name:  string;
  deposit_address:    string;
  hd_index:           number;
}

interface ReadyToMintRow {
  order_id:           string;
  deposit_id:         Buffer;
  recipient_address:  string;
  amount_sat:         bigint;
  mint_nonce:         bigint;
  deadline:           bigint;
  signatures:         Array<{ signer: string; sig: string }>;
  txid:               string;
  vout:               number;
  deposit_value_sat:  bigint | null;
  sigs_updated_at:    Date;
}

interface RegenCandidateRow {
  order_id:           string;
  deposit_id:         Buffer;
  amount_sat:         bigint;
  deposit_amount_sat: bigint | null;
  mint_nonce:         bigint;
  deadline:           bigint;
  last_submit_error:  string | null;
  txid:               string;
  vout:               number;
}

interface SubmittedRow {
  order_id:       string;
  gnosis_tx_hash: string;
}

export interface CapDecision {
  depositSat:  bigint;
  mintSat:     bigint;
  excessSat:   bigint;
  capacitySat: bigint;
  reservedSat: bigint;
  window:      MintCapWindow;
  state:       MintCapChainState;
}

export interface MintExecutorOptions {
  /** Inject a cap reader (tests). Defaults to reading wBOB on Gnosis. */
  capReader?: MintCapReader;
  /** Inject an alert dispatcher (tests). Defaults to config's webhook/email. */
  dispatcher?: Pick<AlertDispatcher, 'dispatch'>;
  /** Clock override in unix seconds (tests). */
  nowSec?: () => bigint;
}

/** JSON-safe snapshot of a split decision, stored on mint_requests.cap_decision and in audit metadata. */
export function capDecisionJson(d: CapDecision): Record<string, string | boolean> {
  return {
    depositSat:       d.depositSat.toString(),
    mintSat:          d.mintSat.toString(),
    excessSat:        d.excessSat.toString(),
    capacitySat:      d.capacitySat.toString(),
    reservedSat:      d.reservedSat.toString(),
    dailyMintLimit:   d.window.limitSat.toString(),
    mintedTodaySat:   d.window.mintedTodaySat.toString(),
    remainingTodaySat: d.window.remainingTodaySat.toString(),
    windowStale:      d.window.windowStale,
    windowStartSec:   d.window.windowStartSec.toString(),
    resetsAtSec:      d.window.resetsAtSec.toString(),
    gnosisBlock:      d.state.blockNumber.toString(),
    gnosisBlockTime:  d.state.blockTimestamp.toString(),
  };
}

/**
 * BridgeControllerV2's replay key for a Dobbscoin output:
 * keccak256(abi.encode(uint256 sourceChainId, bytes32 sourceTxHash, uint32 sourceVout)).
 */
export function outpointKey(sourceChainId: bigint, sourceTxHash: ViemHex, sourceVout: number): ViemHex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('uint256, bytes32, uint32'), [sourceChainId, sourceTxHash, sourceVout],
  ));
}


/** Stable, human-readable name for a simulated revert (stable = no clock values, so it dedups). */
export function describeRevert(err: unknown): { name: string | null; text: string } {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      const name = revert.data.errorName;
      const args = (revert.data.args ?? []).map((a) => String(a));
      // DeadlineExpired carries block.timestamp — drop it so the text dedups.
      const shown = name === 'DeadlineExpired' ? args.slice(0, 1) : args;
      return { name, text: `${name}(${shown.join(', ')})` };
    }
    return { name: null, text: (err.shortMessage || err.message).split('\n')[0]!.slice(0, 300) };
  }
  return { name: null, text: String(err).split('\n')[0]!.slice(0, 300) };
}

// ─── MintExecutor ─────────────────────────────────────────────────────────────

export class MintExecutor {
  private readonly publicClient;
  /** Our own node only: mint verdicts never come from a public fallback. */
  private readonly primaryClient;
  private readonly walletClient;
  private readonly account;
  private readonly capReader: MintCapReader;
  private readonly alerts: Pick<AlertDispatcher, 'dispatch'>;
  private readonly now: () => bigint;
  /** Orders already alerted as minted-on-chain at authorization time (alert once). */
  private readonly alertedAlreadyMinted = new Set<string>();
  private readonly alertedWrongDomain = new Set<string>();
  /** Process start: signatures written before it may predate a controller switch. */
  private readonly startedAt = new Date();

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
    private readonly dripSender: DripSender | null = null,
    opts: MintExecutorOptions = {},
  ) {
    this.account = privateKeyToAccount(config.executorPrivateKey as ViemHex);
    this.publicClient = createPublicClient({
      chain: gnosis,
      // READ path: fallback() across the ordered RPC list so reads survive the
      // node going down. Writers stay pinned to gnosisRpcUrl — see config.ts.
      transport: fallback(config.gnosisRpcUrls.map((u) => http(u))),
    });
    this.primaryClient = createPublicClient({ chain: gnosis, transport: http(config.gnosisRpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
    this.capReader = opts.capReader ?? new ViemMintCapReader(
      this.publicClient as unknown as PublicClient,
      config.wBobAddress,
      config.bridgeControllerAddress,
      config.bridgeControllerVersion,
    );
    this.alerts = opts.dispatcher ?? new AlertDispatcher({
      webhookUrl: config.alertWebhookUrl,
      emailTo:    config.alertEmailTo,
    });
    this.now = opts.nowSec ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  /**
   * Decide how much of `depositSat` can be minted. MUST be called inside a
   * transaction that holds MINT_CAPACITY_LOCK_KEY, and the caller must write
   * its reservation (the mint_requests row) in that same transaction — that
   * is what stops two deposits finalizing together from both claiming the
   * same capacity. The chain is read inside the lock for the same reason: a
   * mint confirmed by another process between an earlier read and the lock
   * would otherwise be counted in neither the chain state nor the reservations.
   */
  async decideSplit(tx: TransactionSql, depositSat: bigint, excludeOrderId: string | null = null): Promise<CapDecision> {
    const state = await this.capReader.readState();
    const window = computeCapWindow(state);

    const reservedSat = await outstandingReservedSat(tx, this.capReader, state, excludeOrderId);
    const capacitySat = availableCapacity(window, reservedSat);
    const { mintSat, excessSat } = splitDeposit(depositSat, capacitySat);
    return { depositSat, mintSat, excessSat, capacitySat, reservedSat, window, state };
  }

  // ── Job 1: create mint_requests (and refunds) for DEPOSIT_FINALIZED orders ─

  /** @param onlyOrderIds restrict to these orders (tests drive concurrent executors with it). */
  async createPendingAuths(onlyOrderIds: string[] | null = null): Promise<void> {
    // Find DEPOSIT_FINALIZED orders without a mint_requests row yet
    const orders = await this.sql<FinalizedOrderRow[]>`
      SELECT
        bo.id                   AS order_id,
        sd.deposit_id,
        bo.user_gnosis_address,
        COALESCE(sd.amount_sat, bo.amount_sat) AS amount_sat,
        sd.txid,
        sd.vout,
        sd.source_chain_name,
        sd.deposit_address,
        sd.hd_index
      FROM bridge_orders bo
      JOIN source_deposits sd ON sd.order_id = bo.id
      LEFT JOIN mint_requests mr ON mr.order_id = bo.id
      WHERE bo.order_type = 'inbound'
        AND bo.state = ${InboundState.DEPOSIT_FINALIZED}
        AND mr.order_id IS NULL
        AND sd.deposit_id IS NOT NULL
        AND sd.txid IS NOT NULL
        ${onlyOrderIds ? this.sql`AND bo.id IN ${this.sql(onlyOrderIds)}` : this.sql``}
      ORDER BY sd.finalized_at NULLS LAST, bo.created_at
    `;

    // (review round 8 #5) Forget check failures of orders no longer pending
    // (minted, parked, refunded), so the stuck alert re-arms after an outage.
    const pendingIds = new Set(orders.map((o) => o.order_id));
    for (const id of [...this.checkFailingSince.keys()]) if (!pendingIds.has(id)) this.checkFailingSince.delete(id);
    if (this.checkFailingSince.size === 0) this.checkFailAlerted = false;

    if (orders.length === 0) return;

    // Fetch current mintNonce once (same for all pending auths this round)
    const mintNonce = await this._readMintNonce();

    for (const order of orders) {
      // Before reserving capacity or authorizing anything: is it minted already?
      try {
        const reason = await this._alreadyMintedReason(bufferToHex(order.deposit_id) as ViemHex, order.txid, order.vout);
        if (reason !== null) {
          this.checkFailingSince.delete(order.order_id);   // the check itself worked
          if (!this.alertedAlreadyMinted.has(order.order_id)) {
            this.alertedAlreadyMinted.add(order.order_id);
            console.error(`[executor] NOT authorizing orderId=${order.order_id}: ${reason}`);
            await this._alert({ level: 'critical', type: 'MINT_SUBMIT_BLOCKED',
              message: `Deposit ${order.txid}:${order.vout} (order ${order.order_id}) was not authorized: ${reason}`,
              data: { orderId: order.order_id, reason } });
          }
          continue;
        }
      } catch (err) {
        console.error(`[executor] already-minted check failed orderId=${order.order_id}; not authorizing this poll:`, err);
        await this._alertIfCheckStuck(order.order_id, err);
        continue;
      }
      this.checkFailingSince.delete(order.order_id);
      if (this.checkFailingSince.size === 0) this.checkFailAlerted = false;   // recovered: the next outage alerts again
      try {
        const outcome = await this.sql.begin(async (tx) => {
          // Serialise capacity decisions bridge-wide (all backend instances).
          await tx`SELECT pg_advisory_xact_lock(${MINT_CAPACITY_LOCK_KEY})`;

          // Re-check state under lock
          const rows = await tx<{ state: string }[]>`
            SELECT state FROM bridge_orders WHERE id = ${order.order_id} FOR UPDATE
          `;
          if (rows.length === 0 || rows[0]!.state !== InboundState.DEPOSIT_FINALIZED) return null;

          const decision = await this.decideSplit(tx, order.amount_sat);
          const depositIdHex = bufferToHex(order.deposit_id);
          const deadline = this.now() + BigInt(this.config.mintDeadlineSeconds);
          const decisionJson = capDecisionJson(decision);
          const next = decision.mintSat > 0n ? InboundState.MINT_AUTH_CREATED : InboundState.REFUNDED;
          assertInboundTransition(InboundState.DEPOSIT_FINALIZED, next);

          if (decision.mintSat > 0n) {
            await tx`
              INSERT INTO mint_requests (
                order_id, deposit_id, recipient_address, amount_sat,
                mint_nonce, deadline, signatures, signature_count,
                deposit_amount_sat, cap_decision
              ) VALUES (
                ${order.order_id},
                ${order.deposit_id},
                ${order.user_gnosis_address},
                ${decision.mintSat.toString()},
                ${mintNonce.toString()},
                ${deadline.toString()},
                '[]'::jsonb,
                0,
                ${order.amount_sat.toString()},
                ${tx.json(decisionJson)}
              )
              ON CONFLICT (order_id) DO NOTHING
            `;
          }

          // Register the deposit UTXO in the bridge pool (idempotent via UNIQUE txid+vout).
          // The WHOLE deposit enters the pool; a refund later spends the excess out of it.
          await tx`
            INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index)
            VALUES (
              ${order.order_id},
              ${order.txid},
              ${order.vout},
              ${order.amount_sat.toString()},
              ${order.deposit_address},
              ${order.hd_index}
            )
            ON CONFLICT (txid, vout) DO NOTHING
          `;

          if (decision.excessSat > 0n) {
            const tooSmall = isRefundTooSmall(decision.excessSat, this.config.dobbscoinFeeRateSatPerVbyte);
            await tx`
              INSERT INTO deposit_refunds (
                order_id, deposit_txid, deposit_vout, deposit_amount_sat,
                mint_amount_sat, excess_sat, status, reason
              ) VALUES (
                ${order.order_id}, ${order.txid}, ${order.vout}, ${order.amount_sat.toString()},
                ${decision.mintSat.toString()}, ${decision.excessSat.toString()},
                ${tooSmall ? 'too_small' : 'queued'},
                ${tooSmall ? 'excess is not more than the network fee plus dust' : null}
              )
              ON CONFLICT DO NOTHING   -- order_id, or (review round 5) the same deposit output
            `;
          }

          await tx`
            UPDATE bridge_orders
            SET state = ${next}, updated_at = now()
            WHERE id = ${order.order_id}
          `;

          await tx`
            INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
            VALUES (
              ${order.order_id},
              'STATE_TRANSITION',
              ${InboundState.DEPOSIT_FINALIZED},
              ${next},
              'mint-executor',
              ${tx.json({
                depositId: depositIdHex,
                mintNonce: mintNonce.toString(),
                deadline: deadline.toString(),
                capSplit: decision.excessSat > 0n,
                ...decisionJson,
              })}
            )
          `;
          return decision;
        });

        if (outcome === null) continue;
        if (outcome.excessSat > 0n) {
          console.warn(
            `[executor] DAILY CAP SPLIT orderId=${order.order_id} deposit=${outcome.depositSat} ` +
            `mint=${outcome.mintSat} refund=${outcome.excessSat} capacity=${outcome.capacitySat} ` +
            `reserved=${outcome.reservedSat}`,
          );
        } else {
          console.log(`[executor] created mint auth for orderId=${order.order_id}`);
        }
      } catch (err) {
        console.error(`[executor] createPendingAuths error orderId=${order.order_id}:`, err);
      }
    }
  }

  // ── Job 0: regenerate expired / stale-nonce authorizations ───────────────

  async regenerateExpiredAuths(): Promise<void> {
    const nowSec = this.now();
    const mintNonce = await this._readMintNonce();

    const candidates = await this.sql<RegenCandidateRow[]>`
      SELECT
        mr.order_id, mr.deposit_id, mr.amount_sat, mr.deposit_amount_sat,
        mr.mint_nonce, mr.deadline, mr.last_submit_error,
        sd.txid, sd.vout
      FROM mint_requests mr
      JOIN bridge_orders bo   ON bo.id = mr.order_id
      JOIN source_deposits sd ON sd.order_id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_AUTH_CREATED}
        AND mr.gnosis_tx_hash IS NULL
        AND (mr.deadline <= ${(nowSec + DEADLINE_MARGIN_SECONDS).toString()} OR mr.mint_nonce <> ${mintNonce.toString()})
    `;

    for (const row of candidates) {
      try {
        await this._regenerate(row, mintNonce);
      } catch (err) {
        console.error(`[executor] regenerate error orderId=${row.order_id}:`, err);
      }
    }
  }

  /**
   * Is this deposit already minted ON-CHAIN, by any controller? Returns the
   * reason (for last_submit_error / the alert) or null. Checks the current
   * controller's processedDeposits, V2's processedOutpoints, and every LEGACY
   * controller's processedDeposits: a V1 mint whose tx the DB never recorded
   * (and which an incomplete import missed) must never be re-authorized on V2.
   */
  /** Order -> first time its already-minted check threw (review round 6 #9: never stall silently). */
  private readonly checkFailingSince = new Map<string, number>();
  private checkFailAlerted = false;
  private async _alertIfCheckStuck(orderId: string, err: unknown): Promise<void> {
    const first = this.checkFailingSince.get(orderId) ?? Date.now();
    this.checkFailingSince.set(orderId, first);
    if (Date.now() - first < 15 * 60_000 || this.checkFailAlerted) return;
    this.checkFailAlerted = true;    // once per outage; re-armed when every check succeeds again
    await this._alert({ level: 'critical', type: 'MINT_SUBMIT_BLOCKED',
      message: `Mints are not being authorized: the already-minted check has failed for ${Math.round((Date.now() - first) / 60_000)} min ` +
        `(order ${orderId}): ${String(err).slice(0, 200)}. Check the Gnosis RPC and LEGACY_BRIDGE_CONTROLLER_ADDRESSES.`,
      data: { orderId } });
  }

  private async _alreadyMintedReason(depositIdHex: ViemHex, txid: string, vout: number): Promise<string | null> {
    const read = (address: string, functionName: 'processedDeposits' | 'processedOutpoints', arg: ViemHex) =>
      this.publicClient.readContract({ address: address as ViemHex, abi: BRIDGE_ABI, functionName, args: [arg] }) as Promise<boolean>;
    if (await read(this.config.bridgeControllerAddress, 'processedDeposits', depositIdHex)) {
      return `AlreadyProcessed(${depositIdHex}) — deposit is already minted on-chain but this order never recorded the tx; reconcile by hand`;
    }
    if (this.config.bridgeControllerVersion === 2) {
      const txh = (txid.startsWith('0x') ? txid : `0x${txid}`) as ViemHex;
      const key = outpointKey(this.config.dobbscoinChainId, txh, vout);
      if (await read(this.config.bridgeControllerAddress, 'processedOutpoints', key)) {
        return `OutpointAlreadyMinted(${key}) — Dobbscoin output ${txid}:${vout} is already minted on-chain ` +
          `under a different depositId; this row is a duplicate or forged. Do NOT re-authorize; investigate`;
      }
    }
    for (const legacy of this.config.legacyBridgeControllerAddresses ?? []) {
      if (await read(legacy, 'processedDeposits', depositIdHex)) {
        return `AlreadyProcessed(${depositIdHex}) on legacy controller ${legacy} — minted there already; ` +
          `the V2 import is missing it. Do NOT re-authorize; reconcile and import the outpoint`;
      }
    }
    return null;
  }

  private async _regenerate(row: RegenCandidateRow, mintNonce: bigint): Promise<void> {
    const depositIdHex = bufferToHex(row.deposit_id) as ViemHex;

    // Never reissue an authorization for a deposit the chain already minted
    // (an executeMint that went out but was not recorded, a duplicate/forged
    // row, or a legacy-controller mint). A human needs to reconcile the DB.
    const mintedReason = await this._alreadyMintedReason(depositIdHex, row.txid, row.vout);
    if (mintedReason !== null) {
      await this._recordSubmitError(row.order_id, mintedReason, 'critical');
      return;
    }

    const legacy = row.deposit_amount_sat === null;
    const result = await this.sql.begin(async (tx) => {
      if (legacy) await tx`SELECT pg_advisory_xact_lock(${MINT_CAPACITY_LOCK_KEY})`;
      const locked = await tx<{ state: string; gnosis_tx_hash: string | null; deadline: bigint; mint_nonce: bigint }[]>`
        SELECT bo.state, mr.gnosis_tx_hash, mr.deadline, mr.mint_nonce
        FROM bridge_orders bo JOIN mint_requests mr ON mr.order_id = bo.id
        WHERE bo.id = ${row.order_id}
        FOR UPDATE OF bo, mr
      `;
      const cur = locked[0];
      if (!cur || cur.state !== InboundState.MINT_AUTH_CREATED || cur.gnosis_tx_hash !== null) return null;
      const nowSec = this.now();
      const expired = cur.deadline <= nowSec + DEADLINE_MARGIN_SECONDS;
      if (!expired && cur.mint_nonce === mintNonce) return null;

      // An authorization created before the daily-cap split existed carries
      // the full deposit, which may never fit under the cap. Split it now,
      // once; from then on it is a decided amount like any other.
      let amountSat = row.amount_sat;
      let decision: CapDecision | null = null;
      if (legacy) {
        decision = await this.decideSplit(tx, row.amount_sat, row.order_id);
        if (decision.mintSat === 0n) return { skipped: 'no capacity left today for a pre-split authorization' as const };
        amountSat = decision.mintSat;
        await tx`
          UPDATE mint_requests
          SET amount_sat = ${amountSat.toString()}, deposit_amount_sat = ${row.amount_sat.toString()},
              cap_decision = ${tx.json(capDecisionJson(decision))}
          WHERE order_id = ${row.order_id}
        `;
        if (decision.excessSat > 0n) {
          const tooSmall = isRefundTooSmall(decision.excessSat, this.config.dobbscoinFeeRateSatPerVbyte);
          await tx`
            INSERT INTO deposit_refunds (
              order_id, deposit_txid, deposit_vout, deposit_amount_sat,
              mint_amount_sat, excess_sat, status, reason
            ) VALUES (
              ${row.order_id}, ${row.txid}, ${row.vout}, ${row.amount_sat.toString()},
              ${decision.mintSat.toString()}, ${decision.excessSat.toString()},
              ${tooSmall ? 'too_small' : 'queued'},
              ${tooSmall ? 'excess is not more than the network fee plus dust' : null}
            )
            ON CONFLICT DO NOTHING   -- order_id, or (review round 5) the same deposit output
          `;
        }
      }

      const newDeadline = nowSec + BigInt(this.config.mintDeadlineSeconds);
      await tx`
        UPDATE mint_requests
        SET deadline             = ${newDeadline.toString()},
            mint_nonce           = ${mintNonce.toString()},
            signatures           = '[]'::jsonb,
            signature_count      = 0,
            mint_authorization   = NULL,
            regenerated_count    = regenerated_count + 1,
            last_submit_error    = NULL,
            last_submit_error_at = NULL,
            updated_at           = now()
        WHERE order_id = ${row.order_id}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${row.order_id}, 'MINT_AUTH_REGENERATED',
          ${InboundState.MINT_AUTH_CREATED}, ${InboundState.MINT_AUTH_CREATED},
          'mint-executor',
          ${tx.json({
            reason: expired ? 'deadline' : 'mintNonce changed',
            oldDeadline: cur.deadline.toString(),
            newDeadline: newDeadline.toString(),
            oldMintNonce: cur.mint_nonce.toString(),
            newMintNonce: mintNonce.toString(),
            amountSat: amountSat.toString(),
            ...(decision ? { legacySplit: capDecisionJson(decision) } : {}),
          })}
        )
      `;
      return { expired, oldDeadline: cur.deadline, newDeadline, amountSat, decision };
    });

    if (result === null) return;
    if ('skipped' in result) {
      console.warn(`[executor] regenerate deferred orderId=${row.order_id}: ${result.skipped}`);
      return;
    }
    const why = result.expired ? 'its deadline passed unminted' : 'the bridge mintNonce changed';
    console.warn(
      `[executor] regenerated mint auth orderId=${row.order_id} (${why}) amount=${result.amountSat} ` +
      `deadline ${result.oldDeadline} → ${result.newDeadline}`,
    );
    await this._alert({
      level: 'info',
      type: 'MINT_AUTH_REGENERATED',
      message:
        `Mint authorization for order ${row.order_id} reissued because ${why}` +
        (row.last_submit_error ? ` (last refusal: ${row.last_submit_error})` : '') +
        `. Minting ${fmtBob(result.amountSat)} wBOB; watchers re-sign.` +
        (result.decision && result.decision.excessSat > 0n
          ? ` Pre-split authorization: ${fmtBob(result.decision.excessSat)} (BOB) over today's cap goes to refund.`
          : ''),
      data: { orderId: row.order_id, newDeadline: result.newDeadline.toString(), amountSat: result.amountSat.toString() },
    });
  }

  // ── Job 2: call executeMint when threshold signatures collected ───────────

  async submitReadyMints(): Promise<void> {
    const nowSec = this.now();
    const ready = await this.sql<ReadyToMintRow[]>`
      SELECT
        mr.order_id,
        mr.deposit_id,
        mr.recipient_address,
        mr.amount_sat,
        mr.mint_nonce,
        mr.deadline,
        mr.signatures,
        sd.txid,
        sd.vout,
        sd.amount_sat AS deposit_value_sat,
        mr.updated_at AS sigs_updated_at
      FROM mint_requests mr
      JOIN bridge_orders bo ON bo.id = mr.order_id
      JOIN source_deposits sd ON sd.order_id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_AUTH_CREATED}
        AND mr.signature_count >= ${SIGNATURE_THRESHOLD}
        AND mr.gnosis_tx_hash IS NULL
        AND mr.deadline > ${(nowSec + DEADLINE_MARGIN_SECONDS).toString()}
        AND (mr.last_submit_error IS NULL OR (mr.last_submit_error NOT LIKE 'AlreadyProcessed%'
                                              AND mr.last_submit_error NOT LIKE 'OutpointAlreadyMinted%'))
    `;

    for (const row of ready) {
      try {
        await this._submitOne(row);
      } catch (err) {
        const { text } = describeRevert(err);
        console.error(`[executor] submitReadyMints error orderId=${row.order_id}:`, err);
        await this._recordSubmitError(row.order_id, text, null).catch(() => undefined);
      }
    }
  }

  private async _submitOne(row: ReadyToMintRow): Promise<void> {
    const depositIdHex = bufferToHex(row.deposit_id) as ViemHex;
    // DB stores Dobbscoin txids in raw Bitcoin-display hex (no 0x prefix).
    // bytes32 ABI encoding needs a 0x-prefixed hex; must match the value the
    // watchers signed (same prefix logic in watcher/src/index.ts).
    const sourceTxHash = (row.txid.startsWith('0x') ? row.txid : `0x${row.txid}`) as ViemHex;
    const auth = {
      depositId:     depositIdHex,
      recipient:     row.recipient_address as ViemHex,
      amount:        row.amount_sat,
      sourceChainId: this.config.dobbscoinChainId,
      sourceTxHash,
      sourceVout:    row.vout,
      // V2 signs the deposit's full value; watchers checked the DB value against their nodes.
      ...(this.config.bridgeControllerVersion === 2 ? { sourceValue: row.deposit_value_sat ?? 0n } : {}),
      deadline:      row.deadline,
      nonce:         row.mint_nonce,
    };
    if (this.config.bridgeControllerVersion === 2 && !row.deposit_value_sat) {
      await this._recordSubmitError(row.order_id,
        'no recorded deposit value (source_deposits.amount_sat) — V2 needs it as sourceValue; reconcile by hand', 'critical');
      return;
    }

    // 1. Keep only signatures that recover to their claimed signer over THIS
    //    auth. A watcher can append a signature it computed over the previous
    //    deadline in the instant a regeneration clears the row; such a sig is
    //    useless on-chain and would hold signature_count at the threshold.
    // Signatures last written before this process started may predate a
    // controller switch: wrong-domain ones are then stale, not misconfiguration.
    const valid = await this._validSignatures(auth, row.signatures, row.sigs_updated_at < this.startedAt);
    if (valid.length < SIGNATURE_THRESHOLD) {
      await this._pruneSignatures(row.order_id, row.signatures, valid, 'signature does not match the current authorization');
      return;
    }

    // 2. Simulate. A revert here is a known refusal — record it, alert once
    //    per distinct reason, and do not send a tx that would burn gas failing.
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        account: this.account,
        address: this.config.bridgeControllerAddress as ViemHex,
        abi: this.config.bridgeControllerVersion === 2 ? BRIDGE_ABI_V2 : BRIDGE_ABI,
        functionName: 'executeMint',
        args: [auth as never, valid.map((e) => e.sig as ViemHex)],
      }));
    } catch (err) {
      const { name, text } = describeRevert(err);
      if (name === null) throw err; // not a contract revert (RPC down…) — plain retry next poll
      if (name === 'InsufficientValidSignatures') {
        await this._dropNonSigners(row.order_id, row.signatures, valid);
      }
      // DeadlineExpired / WrongMintNonce: the regenerator reissues it next poll.
      const level = CRITICAL_REVERTS.has(name) ? 'critical' : 'warning';
      await this._recordSubmitError(row.order_id, text, level);
      return;
    }

    // 3. Send.
    const txHash = await withRelayerLock(() => this.walletClient.writeContract(request));

    // Record tx hash and advance FSM
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== InboundState.MINT_AUTH_CREATED) return;

      await tx`
        UPDATE mint_requests
        SET gnosis_tx_hash = ${txHash}, last_submit_error = NULL, last_submit_error_at = NULL,
            updated_at = now()
        WHERE order_id = ${row.order_id}
      `;

      await tx`
        UPDATE bridge_orders
        SET state = ${InboundState.MINT_SUBMITTED}, updated_at = now()
        WHERE id = ${row.order_id}
      `;

      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${row.order_id},
          'STATE_TRANSITION',
          ${InboundState.MINT_AUTH_CREATED},
          ${InboundState.MINT_SUBMITTED},
          'mint-executor',
          ${tx.json({ gnosisTxHash: txHash, signatures: valid.length })}
        )
      `;
    });

    console.log(`[executor] submitted executeMint txHash=${txHash} orderId=${row.order_id}`);
  }

  private async _validSignatures(
    auth: {
      depositId: ViemHex; recipient: ViemHex; amount: bigint; sourceChainId: bigint;
      sourceTxHash: ViemHex; sourceVout: number; sourceValue?: bigint; deadline: bigint; nonce: bigint;
    },
    sigs: Array<{ signer: string; sig: string }>,
    maybeStale = false,
  ): Promise<Array<{ signer: string; sig: string }>> {
    const domain = {
      ...bridgeControllerDomain(this.config.bridgeControllerVersion),
      verifyingContract: this.config.bridgeControllerAddress as ViemHex,
    } as const;
    const seen = new Set<string>();
    const out: Array<{ signer: string; sig: string }> = [];
    for (const e of sigs ?? []) {
      try {
        const recovered = await recoverTypedDataAddress({
          domain,
          types: mintAuthorizationTypes(this.config.bridgeControllerVersion),
          primaryType: 'MintAuthorization',
          message: auth as never,
          signature: e.sig as ViemHex,
        });
        const who = recovered.toLowerCase();
        if (who === e.signer.toLowerCase() && !seen.has(who)) {
          seen.add(who);
          out.push(e);
        } else if (who !== e.signer.toLowerCase()) {
          // Valid under some OTHER controller domain? Then a watcher is
          // misconfigured (BRIDGE_CONTROLLER_VERSION or BRIDGE_CONTROLLER_ADDRESS
          // left on the old controller) and every mint would stall: say which.
          const why = await this._wrongDomainOf(auth, e);
          if (why !== null && maybeStale) {
            console.warn(`[executor] dropping a pre-switch signature by ${e.signer} (signed for ${why}); it re-signs for the current controller`);
          } else if (why !== null && !this.alertedWrongDomain.has(e.signer.toLowerCase() + why)) {
            this.alertedWrongDomain.add(e.signer.toLowerCase() + why);
            await this._alert({ level: 'critical', type: 'MINT_SUBMIT_BLOCKED',
              message: `Watcher ${e.signer} signs for ${why}, not for ${this.config.bridgeControllerAddress} ` +
                `version ${this.config.bridgeControllerVersion}. Fix BRIDGE_CONTROLLER_ADDRESS / BRIDGE_CONTROLLER_VERSION ` +
                `on that watcher; its signatures are ignored until then.`,
              data: { signer: e.signer, signsFor: why } });
          }
        }
      } catch {
        // malformed signature — dropped
      }
    }
    return out;
  }

  /** If `e` is a valid signature by its signer under another known controller domain, describe it. */
  private async _wrongDomainOf(
    auth: Parameters<MintExecutor['_validSignatures']>[0],
    e: { signer: string; sig: string },
  ): Promise<string | null> {
    const addresses = [this.config.bridgeControllerAddress, ...(this.config.legacyBridgeControllerAddresses ?? [])];
    for (const address of addresses) {
      for (const version of [1, 2] as const) {
        if (address.toLowerCase() === this.config.bridgeControllerAddress.toLowerCase()
            && version === this.config.bridgeControllerVersion) continue;
        const got = await recoverTypedDataAddress({
          domain: { ...bridgeControllerDomain(version), verifyingContract: address as ViemHex },
          types: mintAuthorizationTypes(version), primaryType: 'MintAuthorization',
          message: (version === 2 ? auth : stripSourceValue(auth)) as never, signature: e.sig as ViemHex,
        }).catch(() => null);
        if (got && got.toLowerCase() === e.signer.toLowerCase()) return `${address} version ${version}`;
      }
    }
    return null;
  }

  /** Replace the signature list with `keep`, only if nobody changed it since we read it. */
  private async _pruneSignatures(
    orderId: string,
    original: Array<{ signer: string; sig: string }>,
    keep: Array<{ signer: string; sig: string }>,
    why: string,
  ): Promise<void> {
    if (keep.length === (original ?? []).length) return;
    const updated = await this.sql`
      UPDATE mint_requests
      SET signatures = ${this.sql.json(keep)}, signature_count = ${keep.length}, updated_at = now()
      WHERE order_id = ${orderId}
        AND gnosis_tx_hash IS NULL
        AND signatures = ${this.sql.json(original)}
    `;
    if (updated.count > 0) {
      console.warn(
        `[executor] dropped ${(original ?? []).length - keep.length} signature(s) orderId=${orderId}: ${why}; ` +
        `watchers re-sign below the threshold`,
      );
    }
  }

  /** On InsufficientValidSignatures: keep only signatures from currently registered signers. */
  private async _dropNonSigners(
    orderId: string,
    original: Array<{ signer: string; sig: string }>,
    valid: Array<{ signer: string; sig: string }>,
  ): Promise<void> {
    const keep: Array<{ signer: string; sig: string }> = [];
    for (const e of valid) {
      const registered = await this.publicClient.readContract({
        address: this.config.bridgeControllerAddress as ViemHex,
        abi: BRIDGE_ABI,
        functionName: 'isSigner',
        args: [e.signer as ViemHex],
      }) as boolean;
      if (registered) keep.push(e);
    }
    await this._pruneSignatures(orderId, original, keep, 'signer is not registered on BridgeController');
  }

  /**
   * Persist the latest refusal on the mint_request. Alerts (when `level` is
   * set) only when the reason CHANGES, so a mint held all afternoon by the cap
   * pages once, not every 15 seconds.
   */
  private async _recordSubmitError(orderId: string, text: string, level: Alert['level'] | null): Promise<void> {
    const changed = await this.sql`
      UPDATE mint_requests
      SET last_submit_error = ${text}, last_submit_error_at = now()
      WHERE order_id = ${orderId}
        AND last_submit_error IS DISTINCT FROM ${text}
    `;
    if (changed.count === 0) return;
    console.warn(`[executor] mint held orderId=${orderId}: ${text}`);
    if (level === null) return;
    await this._alert({
      level,
      type: 'MINT_SUBMIT_BLOCKED',
      message: `executeMint for order ${orderId} refused in simulation: ${text}. Not sent; held until it can succeed.`,
      data: { orderId, reason: text },
    });
  }

  // ── Job 3: confirm MINT_SUBMITTED → MINT_CONFIRMED → COMPLETED ───────────

  async confirmSubmittedMints(): Promise<void> {
    const submitted = await this.sql<SubmittedRow[]>`
      SELECT mr.order_id, mr.gnosis_tx_hash
      FROM mint_requests mr
      JOIN bridge_orders bo ON bo.id = mr.order_id
      WHERE bo.state = ${InboundState.MINT_SUBMITTED}
        AND mr.gnosis_tx_hash IS NOT NULL
    `;

    // (review round 12) The verdict comes from OUR node (not the public
    // fallbacks), and only once the receipt's block is finalized: otherwise a
    // reorged-out or misreported mint could be marked COMPLETED (or FAILED).
    let finalized: bigint | null = null;
    if (submitted.length > 0) {
      try { finalized = (await this.primaryClient.getBlock({ blockTag: 'finalized' })).number ?? null; }
      catch { finalized = null; }
      if (finalized === null) return;                  // can't tell: try again next poll
    }
    for (const row of submitted) {
      try {
        const receipt = await this.primaryClient.getTransactionReceipt({
          hash: row.gnosis_tx_hash as ViemHex,
        }).catch(() => null);

        if (receipt === null) continue; // not yet mined (or not on our node yet)
        if (finalized !== null && receipt.blockNumber > finalized) continue;   // wait for finality

        if (receipt.status === 'reverted') {
          // executeMint reverted — mark FAILED
          await this._transitionOrder(
            row.order_id,
            InboundState.MINT_SUBMITTED,
            InboundState.FAILED,
            { gnosisTxHash: row.gnosis_tx_hash, reason: 'tx reverted' },
          );
          console.warn(`[executor] executeMint reverted orderId=${row.order_id}`);
          // (review round 11) FAILED is terminal and excluded from STUCK_ORDERS:
          // without this the depositor is simply never paid, silently.
          await this._alert({ level: 'critical', type: 'MINT_REVERTED',
            message: `executeMint for order ${row.order_id} REVERTED on Gnosis (${row.gnosis_tx_hash}); the order is FAILED and ` +
              `the deposit is unminted. Find out why (deadline, pause, nonce bump, cap) and re-queue or refund it by hand.`,
            data: { orderId: row.order_id, gnosisTxHash: row.gnosis_tx_hash } });
          continue;
        }

        // Success: MINT_SUBMITTED → MINT_CONFIRMED → COMPLETED
        await this._transitionOrder(
          row.order_id,
          InboundState.MINT_SUBMITTED,
          InboundState.MINT_CONFIRMED,
          { gnosisTxHash: row.gnosis_tx_hash, blockNumber: receipt.blockNumber.toString() },
        );

        await this.sql`
          UPDATE mint_requests
          SET gnosis_block_number = ${receipt.blockNumber},
              confirmed_at = now(),
              updated_at = now()
          WHERE order_id = ${row.order_id}
        `;

        await this._transitionOrder(
          row.order_id,
          InboundState.MINT_CONFIRMED,
          InboundState.COMPLETED,
          { gnosisTxHash: row.gnosis_tx_hash },
        );

        console.log(`[executor] mint confirmed orderId=${row.order_id}`);

        // ── Gas drip (Option 2) ─────────────────────────────────────────
        // Fire-and-log only — failures must not affect the mint outcome.
        if (this.dripSender) {
          try {
            // Qualify on what was MINTED, not what was deposited: with the
            // daily-cap split the two can differ.
            const [recip] = await this.sql<{ user_gnosis_address: string; amount_sat: bigint }[]>`
              SELECT bo.user_gnosis_address, mr.amount_sat
              FROM bridge_orders bo
              JOIN mint_requests mr ON mr.order_id = bo.id
              WHERE bo.id = ${row.order_id}
            `;
            if (recip?.user_gnosis_address && recip.amount_sat) {
              const decision = await this.dripSender.sendDripIfEligible(
                recip.user_gnosis_address,
                row.order_id,
                recip.amount_sat,
              );
              console.log(
                `[executor] drip orderId=${row.order_id} recipient=${recip.user_gnosis_address} outcome=${decision.outcome}` +
                  (decision.txHash ? ` tx=${decision.txHash}` : '') +
                  (decision.message ? ` ${decision.message}` : ''),
              );
            }
          } catch (err) {
            console.error(`[executor] drip threw (mint already completed) orderId=${row.order_id}:`, err);
          }
        }
      } catch (err) {
        console.error(`[executor] confirmSubmittedMints error orderId=${row.order_id}:`, err);
      }
    }
  }

  // ── Main poll loop ────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    // Confirm first: a mint that landed since the last poll must leave the
    // reservation sum before createPendingAuths sizes new deposits against it.
    // Each job is isolated so one failing RPC read cannot starve the others.
    const jobs: Array<[string, () => Promise<void>]> = [
      ['confirmSubmittedMints',  () => this.confirmSubmittedMints()],
      ['regenerateExpiredAuths', () => this.regenerateExpiredAuths()],
      ['createPendingAuths',     () => this.createPendingAuths()],
      ['submitReadyMints',       () => this.submitReadyMints()],
    ];
    for (const [name, job] of jobs) {
      try {
        await job();
      } catch (err) {
        console.error(`[executor] ${name} failed:`, err);
      }
    }
  }

  async start(): Promise<void> {
    console.log(`[executor] started. executor=${this.account.address}`);
    while (true) {
      try {
        await this.poll();
      } catch (err) {
        console.error('[executor] poll error:', err);
      }
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _readMintNonce(): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.config.bridgeControllerAddress as ViemHex,
      abi: BRIDGE_ABI,
      functionName: 'mintNonce',
    }) as bigint;
  }

  private async _alert(a: Omit<Alert, 'timestamp'>): Promise<void> {
    try {
      await this.alerts.dispatch({ ...a, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[executor] alert dispatch failed:', err);
    }
  }

  private async _transitionOrder(
    orderId: string,
    from: InboundState,
    to: InboundState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    assertInboundTransition(from, to);

    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== from) return;

      await tx`
        UPDATE bridge_orders SET state = ${to}, updated_at = now()
        WHERE id = ${orderId}
      `;

      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId}, 'STATE_TRANSITION', ${from}, ${to},
          'mint-executor', ${tx.json(metadata)}
        )
      `;
    });
  }
}
