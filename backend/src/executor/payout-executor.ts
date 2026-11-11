/**
 * Payout executor — Phase 5.
 *
 * Drives the outbound FSM from PAYOUT_QUEUED through to COMPLETED:
 *
 *   PAYOUT_QUEUED
 *     → select UTXOs, build & sign Dobbscoin tx
 *     → store signed tx in payouts table
 *   PAYOUT_QUEUED → PAYOUT_SIGNED
 *     → sendrawtransaction to Dobbscoin node
 *   PAYOUT_SIGNED → PAYOUT_BROADCAST
 *     → poll confirmations
 *   PAYOUT_BROADCAST → PAYOUT_CONFIRMED → COMPLETED
 */

import type { Sql } from 'postgres';
import { OutboundState, assertOutboundTransition } from '@wbob/shared';
import { RpcCallError, RpcNetworkError, type DobbscoinBackendRpc } from '../dobbscoin/rpc.js';
import { DobbscoinTxBuilder, DUST_THRESHOLD_SAT, txidFromRawHex, txInputsFromRawHex, txOutputsFromRawHex, type UtxoInput } from '../dobbscoin/tx-builder.js';
import type { BackendConfig } from '../config.js';
import { nextChangeIndex, type RefundExecutor } from './refund-executor.js';
import { unpayableDestinationReason } from '../gnosis/destination.js';
import { BurnVerifier, type BurnVerifierLike } from '../gnosis/burn-verifier.js';
import { AlertDispatcher } from '../monitor/webhook.js';
import type { Alert } from '../monitor/types.js';

/** A selected UTXO was reserved by someone else before we could reserve it. */
/** An earlier signed payout for this withdrawal is still alive and none of its coins is free to conflict with: wait. */
export class EarlierPayoutBusyError extends Error {
  constructor(txid: string) { super(`earlier payout ${txid} is still valid and none of its coins is free yet; waiting so the new payout can spend one`); this.name = 'EarlierPayoutBusyError'; }
}

export class UtxoRaceError extends Error {
  constructor(outpoint: string) { super(`UTXO ${outpoint} was taken before it could be reserved`); this.name = 'UtxoRaceError'; }
}

/** Reason to park a withdrawal too small to pay, before any UTXO is touched; null if payable. */
export function belowPayoutMinimumReason(amountSat: bigint, minSat: bigint): string | null {
  if (amountSat > minSat) return null;
  return `withdrawal of ${amountSat} sat is at or under the payout minimum (${minSat} sat; ` +
    `dust is ${DUST_THRESHOLD_SAT}); not signed. Re-mint the burned wBOB to the sender, or pay by hand.`;
}

/**
 * True only when the node refused the tx for a reason that proves it is in NO
 * mempool and its inputs are not spent by anything else, so they are safe to
 * reuse. ALLOWLIST (fails safe): any reason not listed, including RBF
 * replacement refusals ("insufficient fee, rejecting replacement", "too many
 * potential replacements", ...), mempool conflicts, missing/spent inputs and
 * "already known", keeps the reservation. Codes: -26 RPC_VERIFY_REJECTED,
 * -22 deserialization (the hex never parsed, so nothing was relayed).
 */
const SAFE_REJECTION = new RegExp([
  '\\bdust\\b', 'min relay fee not met', 'insufficient priority', 'mempool min fee not met',
  'rate limited free transaction', 'non-mandatory-script-verify-flag', 'mandatory-script-verify-flag-failed',
  'scriptsig-size', 'scriptsig-not-pushonly', 'scriptpubkey', 'bare-multisig', 'multi-op-return',
  '\\bversion\\b', 'tx-size', 'absurdly-high-fee', 'bad-txns-vout-negative', 'bad-txns-vout-toolarge',
  'bad-txns-oversize', 'bad-txns-txouttotal-toolarge', 'non-final',
].join('|'), 'i');
const UNSAFE_HINT = /replace|conflict|missing|spent|already|known|exists/i;

export function isDefiniteRejection(err: unknown): boolean {
  if (!(err instanceof RpcCallError) || err.method !== 'sendrawtransaction') return false;
  if (err.code === -22) return true;
  if (err.code !== -26) return false;
  return SAFE_REJECTION.test(err.message) && !UNSAFE_HINT.test(err.message);
}


const PAYOUT_MIN_CONFIRMATIONS = 3;
/**
 * How deep another tx spending an earlier payout's input must be before that
 * payout counts as dead (review round 9 #2). Shallower, a miner could still
 * swap the old payout in: wait instead.
 */
const SPENDER_MIN_CONFIRMATIONS = 6;
/** Re-sends of the same signed tx on retryable failures before parking it (~1 h at the 15 s poll). */
const MAX_SEND_ATTEMPTS = 240;
/** A broadcast payout the node no longer knows is re-sent at most this often. */
const RESEND_FORGOTTEN_AFTER_MS = 10 * 60_000;
/** Consecutive refused re-sends (one per RESEND_FORGOTTEN_AFTER_MS) before parking: ~30 min. */
const RESEND_FORGOTTEN_MAX_FAILURES = 3;

/**
 * Worth re-sending the SAME tx later (always safe: identical tx): the node was
 * unreachable/busy/warming up, an input is not visible YET (-25: e.g. a parent
 * payout's change the node forgot and that is re-sent first), or a mempool
 * limit that clears with the next block.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof RpcNetworkError) return true;
  if (!(err instanceof RpcCallError)) return false;
  if (err.code === -28 /* RPC_IN_WARMUP */) return true;
  if (err.method === 'sendrawtransaction' && err.code === -25) return true;
  if (err.method === 'sendrawtransaction' && err.code === -26 && /too-long-mempool-chain|mempool full/i.test(err.message)) return true;
  return false;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface QueuedPayoutRow {
  order_id:          string;
  dobbscoin_address: string;
  amount_sat:        bigint;
  /** Set when this order was signed before (an operator re-queued it from MANUAL_REVIEW). */
  payout_id:         string | null;
  payout_txid:       string | null;
  held_utxos:        number;   // bridge_utxos still reserved by that payout
  spent_utxos:       number;   // bridge_utxos marked spent by that payout
  withdrawal_id:     string | null;
  burn_tx_hash:      string | null;
  sender_address:    string | null;
  wr_amount_sat:     bigint | null;
  wr_dobbscoin_address: string | null;
  /** Other withdrawal_requests rows claiming the same withdrawal_id or burn log (must be 0). */
  same_burn_rows:    number;
}

interface SignedPayoutRow {
  order_id:       string;
  payout_id:      string;
  signed_hex:     string;
  change_sat:     string | null;   // comes back as JSON string via metadata->>
  change_address: string | null;
  change_index:   string | null;
}

interface BroadcastPayoutRow {
  order_id:     string;
  payout_id:    string;
  txid:         string;
  broadcast_at: Date | null;
}

interface BridgeUtxoRow {
  id:        string;
  txid:      string;
  vout:      number;
  amount_sat: bigint;
  address:   string;
  hd_index:  number;
  derivation_path: 'deposit' | 'change';
}

// ─── PayoutExecutor ───────────────────────────────────────────────────────────

export class PayoutExecutor {
  private readonly txBuilder: DobbscoinTxBuilder;
  /** payoutId → last re-send of a forgotten payout, and consecutive refusals. */
  private readonly resendState = new Map<string, { last: number; failures: number }>();
  private readonly burnVerifier: BurnVerifierLike;

  constructor(
    private readonly sql: Sql,
    private readonly rpc: DobbscoinBackendRpc,
    private readonly config: BackendConfig,
    /**
     * Over-cap deposit refunds. Run inside this executor's poll, after payouts,
     * so payouts and refunds never pick bridge UTXOs at the same time.
     */
    private readonly refunds: RefundExecutor | null = null,
    /** Re-reads each burn on Gnosis before its payout is signed (review round 5 #1). */
    burnVerifier: BurnVerifierLike | null = null,
  ) {
    this.burnVerifier = burnVerifier ?? new BurnVerifier(config);
    this.txBuilder = new DobbscoinTxBuilder(
      config.hdWalletXpriv,
      config.dobbscoinAddressVersion,
    );
  }

  async poll(): Promise<void> {
    try {
      await this.processQueued();
      await this.broadcastSigned();
      await this.confirmBroadcast();
      await this.checkTerminalWithdrawalsPaid().catch((err) => console.error('[payout-executor] paid-check failed:', err));
    } finally {
      // Refunds run even when a payout step throws; same loop, never concurrent.
      if (this.refunds) await this.refunds.poll();
    }
  }

  async start(): Promise<void> {
    console.log('[payout-executor] started');
    while (true) {
      try { await this.poll(); }
      catch (err) { console.error('[payout-executor] poll error:', err); }
      await new Promise<void>((r) => setTimeout(r, this.config.executorPollIntervalMs));
    }
  }

  // ── Job 1: PAYOUT_QUEUED → PAYOUT_SIGNED ─────────────────────────────────

  private async processQueued(): Promise<void> {
    const queued = await this.sql<QueuedPayoutRow[]>`
      SELECT
        bo.id                     AS order_id,
        bo.user_dobbscoin_address AS dobbscoin_address,
        bo.amount_sat,
        p.id                      AS payout_id,
        p.txid                    AS payout_txid,
        (SELECT count(*)::int FROM bridge_utxos u WHERE p.id IS NOT NULL AND u.spent_payout_id = p.id AND u.status = 'reserved') AS held_utxos,
        (SELECT count(*)::int FROM bridge_utxos u WHERE p.id IS NOT NULL AND u.spent_payout_id = p.id AND u.status = 'spent')    AS spent_utxos,
        wr.withdrawal_id::text    AS withdrawal_id,
        wr.burn_tx_hash,
        wr.sender_address,
        wr.amount_sat             AS wr_amount_sat,
        wr.dobbscoin_address      AS wr_dobbscoin_address,
        (SELECT count(*)::int FROM withdrawal_requests o
          WHERE o.id <> wr.id AND o.withdrawal_id = wr.withdrawal_id) AS same_burn_rows
      FROM bridge_orders bo
      LEFT JOIN withdrawal_requests wr ON wr.order_id = bo.id
      LEFT JOIN payouts p ON p.withdrawal_request_id = wr.id
      WHERE bo.order_type = 'outbound'
        AND bo.state = ${OutboundState.PAYOUT_QUEUED}
    `;

    for (const row of queued) {
      const unpayable = unpayableDestinationReason(row.dobbscoin_address)
        ?? belowPayoutMinimumReason(row.amount_sat, this.config.payoutMinSat);
      if (unpayable !== null) {
        await this._park(row.order_id, OutboundState.PAYOUT_QUEUED, unpayable);
        continue;
      }

      // ── Operator retry (MANUAL_REVIEW → PAYOUT_QUEUED) of an order signed before ──
      if (row.payout_id !== null) {
        if (row.payout_txid !== null || row.spent_utxos > 0) {
          // Already went out (or its inputs are recorded spent): re-sending or
          // re-signing could pay twice. Nothing safe to do automatically.
          await this._park(row.order_id, OutboundState.PAYOUT_QUEUED,
            `retry refused: payout ${row.payout_id} was already broadcast` +
            (row.payout_txid ? ` as ${row.payout_txid}` : '') + `; check the chain, do not re-queue`);
          continue;
        }
        if (row.held_utxos > 0) {
          // Its signed tx still holds its inputs: re-send THAT tx. Identical tx,
          // same txid, same inputs, so it can never pay twice.
          await this._transitionGeneric(row.order_id, OutboundState.PAYOUT_QUEUED, OutboundState.PAYOUT_SIGNED,
            'RETRY_SAME_TX', { payoutId: row.payout_id });
          console.log(`[payout-executor] retry orderId=${row.order_id}: re-sending the same signed tx`);
          continue;
        }
        // Inputs were released (the node refused it outright): sign a new tx
        // under the same payout row; broadcastSigned only ever sends the newest.
        // Belt and braces before creating a second tx: our node must hold none
        // of the older signed txs for this payout.
        const older = await this.sql<{ txid: string | null; hex: string | null }[]>`
          SELECT metadata->>'txid' AS txid, metadata->>'signedHex' AS hex FROM audit_events
          WHERE order_id = ${row.order_id} AND event_type = 'PAYOUT_SIGNED' AND metadata->>'payoutId' = ${row.payout_id}
        `;
        let blocked: string | null = null;
        for (const o of older) {
          const t = o.txid ?? (o.hex ? txidFromRawHex(o.hex) : null);
          if (t === null) continue;
          const has = await this._nodeHas(t);
          if (has !== 'no') { blocked = `older tx ${t} for this payout: node says ${has ?? 'unreachable'}`; break; }
        }
        if (blocked !== null) {
          if (blocked.endsWith('unreachable')) { console.warn(`[payout-executor] re-sign deferred orderId=${row.order_id}: ${blocked}`); continue; }
          await this._park(row.order_id, OutboundState.PAYOUT_QUEUED, `re-sign refused: ${blocked}`);
          continue;
        }
      }

      // ── This burn must never have been paid before ──
      // Payout rows and UTXO links are ordinary rows a DB writer can erase; the
      // append-only audit trail and our node cannot be. Every payout ever signed
      // for this withdrawalId (on ANY order) must be unknown to the node.
      const alive: { txid: string; inputs: { txid: string; vout: number }[]; optional?: boolean }[] = [];
      const seen = { maxAuditId: 0n };
      const paid = await this._alreadyPaidReason(row, alive, seen);
      if (paid !== null) {
        if (paid.defer) { console.warn(`[payout-executor] payout deferred orderId=${row.order_id}: ${paid.reason}`); await this._noteDefer(row.order_id, paid.reason); continue; }
        await this._park(row.order_id, OutboundState.PAYOUT_QUEUED, paid.reason);
        await this._alertCritical(`Payout REFUSED for order ${row.order_id}: ${paid.reason}. ` +
          `Paying again would pay one burn twice: possible DB tampering. Do not pay by hand.`,
          { orderId: row.order_id, reason: paid.reason });
        continue;
      }

      // ── The burn must exist on Gnosis exactly as we are about to pay it ──
      // (only here: this is the one place a NEW payout signature is created).
      const bad = await this._burnNotBackedReason(row);
      if (bad !== null) {
        if (bad.defer) { console.warn(`[payout-executor] payout deferred orderId=${row.order_id}: ${bad.reason}`); await this._noteDefer(row.order_id, bad.reason); continue; }
        await this._park(row.order_id, OutboundState.PAYOUT_QUEUED, bad.reason);
        await this._alertCritical(`Payout REFUSED for order ${row.order_id}: ${bad.reason}. ` +
          `The DB does not match the chain: possible tampering. Do not pay by hand without checking the burn tx.`,
          { orderId: row.order_id, reason: bad.reason });
        continue;
      }

      try {
        await this._buildAndSignPayout(row, alive, seen.maxAuditId);
        this._clearDefer(row.order_id);
      } catch (err) {
        if (err instanceof EarlierPayoutBusyError) {
          console.warn(`[payout-executor] payout deferred orderId=${row.order_id}: ${err.message}`);
          await this._noteDefer(row.order_id, err.message);
          continue;
        }
        if (err instanceof UtxoRaceError) {
          console.warn(`[payout-executor] ${err.message}; retrying orderId=${row.order_id} next poll`);
          continue;
        }
        console.error(`[payout-executor] processQueued error orderId=${row.order_id}:`, err);
        await this._park(row.order_id, OutboundState.PAYOUT_QUEUED, String(err));
      }
    }
  }

  /**
   * Null if no payout was ever signed for this withdrawal, or every one signed is
   * unknown to our node (refused outright, never relayed). Looks across ALL orders
   * whose ORDER_CREATED audit row names this withdrawalId, so re-creating the
   * order, deleting the payouts row or unlinking UTXOs does not hide a payment.
   */
  private async _alreadyPaidReason(
    row: QueuedPayoutRow,
    alive: { txid: string; inputs: { txid: string; vout: number }[]; optional?: boolean }[] = [],
    seen: { maxAuditId: bigint } = { maxAuditId: 0n },
  ): Promise<{ defer: boolean; reason: string } | null> {
    if (row.withdrawal_id === null) return { defer: false, reason: 'no withdrawal_requests row for this order' };
    const W = row.withdrawal_id;
    // (review round 10 #1) Only an order the append-only trail created FOR this
    // withdrawal may be paid. Otherwise a DB writer moves the withdrawal row onto
    // fresh order after fresh order, each payout sitting on an order no later
    // check reads. Forging an ORDER_CREATED row for it only makes it findable.
    const [own] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_events
      WHERE order_id = ${row.order_id} AND event_type = 'ORDER_CREATED' AND metadata->>'withdrawalId' = ${W}
    `;
    if (!own || own.n === 0) {
      return { defer: false, reason: `order ${row.order_id} has no ORDER_CREATED audit row for withdrawalId ${W}: ` +
        `the withdrawal row may have been moved onto it` };
    }
    // Every payout ever signed for W: on any order the trail created for W, or
    // stamped with W (PAYOUT_SIGNED.withdrawalId, review round 10 #1).
    const signed = await this.sql<{ id: string; order_id: string; event_type: string; txid: string | null; hex: string | null }[]>`
      SELECT a.id::text, a.order_id::text, a.event_type, a.metadata->>'txid' AS txid, a.metadata->>'signedHex' AS hex
      FROM audit_events a
      WHERE a.event_type IN ('PAYOUT_SIGNED', 'PAYOUT_SENT_OUT_OF_STATE', 'PAYOUT_BROADCAST')
        AND (a.metadata->>'withdrawalId' = ${W}
             OR a.order_id IN (
               SELECT o.order_id FROM audit_events o
               WHERE o.event_type = 'ORDER_CREATED' AND o.metadata->>'withdrawalId' = ${W}
               UNION SELECT ${row.order_id}::uuid))
    `;
    // (review round 10 #2) A payout is identified ONLY by the hash of its own
    // signed bytes; the `txid` field of a row is a claim (the bridge role can
    // INSERT rows) and must agree with the bytes, or the row is a forgery.
    for (const e of signed) if (BigInt(e.id) > seen.maxAuditId) seen.maxAuditId = BigInt(e.id);
    const hexOf = new Map<string, string>();
    const ids = new Set<string>();
    for (const e of signed) {
      if (e.hex) {
        let h: string;
        try { h = txidFromRawHex(e.hex); }
        catch { return { defer: false, reason: `an audit row (order ${e.order_id}) holds signed payout data that does not parse` }; }
        if (e.txid && e.txid.toLowerCase() !== h) {
          return { defer: false, reason: `an audit ${e.event_type} row (order ${e.order_id}) claims txid ${e.txid} for data that hashes to ${h}: forged?` };
        }
        hexOf.set(h, e.hex);
        ids.add(h);
      } else if (e.txid) {
        ids.add(e.txid.toLowerCase());
      }
    }
    for (const t of ids) {
      const has = await this._nodeHas(t);
      if (has === null) return { defer: true, reason: `node unreachable while checking earlier payout ${t}` };
      if (has !== 'no') {
        return { defer: false, reason: `withdrawalId ${W} was already paid: payout ${t} is ${has === 'chain' ? 'confirmed' : 'in the mempool'}` };
      }
      // Unknown by its txid is not enough (review round 7 #2): Dobbscoin is
      // pre-segwit, so a malleated copy can confirm under ANOTHER txid. Every
      // earlier payout must be checkable: its signed bytes must be on record.
      const hex = hexOf.get(t);
      if (!hex) return { defer: false, reason: `earlier payout ${t} of withdrawalId ${W} has no signed data on record: cannot rule out a malleated copy` };
      let ins: { txid: string; vout: number }[];
      try { ins = txInputsFromRawHex(hex); }
      catch { return { defer: false, reason: `earlier payout ${t} of withdrawalId ${W}: its signed data does not parse` }; }
      let dead = false;
      for (const i of ins) {
        let unspent: boolean;
        try { unspent = await this.rpc.isUnspent(i.txid, i.vout); }
        catch { return { defer: true, reason: `node unreachable while checking inputs of earlier payout ${t}` }; }
        if (!unspent) {
          // (review round 11) gettxout is null both for a spent output and for one
          // whose parent tx our node doesn't have. A missing parent is no evidence
          // of a payment: wait (the stuck-payout alert reports it), never claim
          // "possibly paid".
          const parentConfs = await this.rpc.getConfirmations(i.txid).catch(() => null);
          if (parentConfs === null) return { defer: true, reason: `node unreachable while checking the parent of ${i.txid}:${i.vout}` };
          if (parentConfs < 0) {
            return { defer: true, reason: `input ${i.txid}:${i.vout} of earlier payout ${t}: its parent tx is unknown to our node; waiting` };
          }
          const spender = await this._knownSpender(i.txid, i.vout, [...hexOf.values()]);
          if (spender.kind === 'ok') { dead = true; continue; }
          if (spender.kind === 'wait') return { defer: true, reason: spender.why };
          return { defer: false, reason: `an input (${i.txid}:${i.vout}) of earlier payout ${t} is spent and ` +
            `${t} itself is unknown: ${spender.why}. Possibly a malleated copy that paid this withdrawal; check by hand` };
        }
      }
      // (review round 11) Unknown to the node with every coin still unspent:
      // it was refused or never sent, but it is STILL a valid signed tx that
      // anyone holding its bytes could get mined. The new payout must spend
      // one of its coins, so the two conflict and at most one ever confirms.
      if (!dead) {
        alive.push({ txid: t, inputs: ins });
      } else {
        // (review round 11) "Dead" rests on a 6-deep spend of ONE input. If
        // another of its coins is still unspent, spend it anyway when free: no
        // reliance on reorg depth for this attempt.
        const free: { txid: string; vout: number }[] = [];
        for (const i of ins) {
          try { if (await this.rpc.isUnspent(i.txid, i.vout)) free.push(i); } catch { /* best effort */ }
        }
        if (free.length > 0) alive.push({ txid: t, inputs: free, optional: true });
      }
    }
    // (review round 11) Earlier attempts that are still valid must also conflict
    // with EACH OTHER: two that share no coin could both be mined (paying twice)
    // whatever the new payout does. That needs a human.
    const live = alive.filter((a) => !a.optional);
    for (let x = 0; x < live.length; x++) {
      for (let y = x + 1; y < live.length; y++) {
        const share = live[x]!.inputs.some((i) => live[y]!.inputs.some((j) => j.txid === i.txid && j.vout === i.vout));
        if (!share) {
          return { defer: false, reason: `earlier payouts ${live[x]!.txid} and ${live[y]!.txid} of withdrawalId ${W} are both still valid ` +
            `and share no coin: both could confirm. Spend a coin of one of them first; check by hand` };
        }
      }
    }
    return null;
  }

  /**
   * Who spent txid:vout, an input of an earlier payout for this withdrawal?
   * (review round 9 #1/#2) The audit trail only SUGGESTS candidates: the
   * `bridge` DB role can INSERT audit rows, so every fact comes from our node:
   *   - the node has the candidate, and ITS inputs include txid:vout;
   *   - it pays out differently from every tx ever signed for this withdrawal
   *     (a malleated copy keeps the outputs, a real reuse by another payout or
   *     refund does not);
   *   - it is SPENDER_MIN_CONFIRMATIONS deep (shallower: wait).
   * 'ok' = the outpoint is provably taken by another tx, so no earlier payout
   * for this withdrawal can ever confirm.
   */
  private async _knownSpender(txid: string, vout: number, withdrawalHexes: string[]):
      Promise<{ kind: 'ok' | 'wait' | 'none'; why: string }> {
    const le = Buffer.alloc(4); le.writeUInt32LE(vout, 0);
    const needle = Buffer.from(txid, 'hex').reverse().toString('hex') + le.toString('hex');
    const cands = await this.sql<{ txid: string | null; hex: string | null }[]>`
      SELECT metadata->>'txid' AS txid, metadata->>'signedHex' AS hex FROM audit_events
      WHERE (event_type = 'PAYOUT_SIGNED' AND position(${needle} IN lower(metadata->>'signedHex')) > 0)
         OR (event_type = 'REFUND_SIGNED' AND metadata->'inputs' ? ${`${txid}:${vout}`})
    `;
    const outKey = (outs: { valueSat: bigint; script: string }[]) =>
      outs.map((o) => `${o.valueSat}:${o.script.toLowerCase()}`).sort().join('|');
    const ours = new Set<string>();
    for (const h of withdrawalHexes) { try { ours.add(outKey(txOutputsFromRawHex(h))); } catch { /* unparseable: no match */ } }
    let waitWhy: string | null = null;
    const tried = new Set<string>();
    for (const c of cands) {
      // Candidate ids from the row, and (if it carries hex) the id its hex hashes to.
      const ids = [c.txid, c.hex ? txidFromRawHex(c.hex) : null].filter((x): x is string => !!x && /^[0-9a-f]{64}$/i.test(x));
      for (const ct of ids) {
        if (tried.has(ct)) continue;
        tried.add(ct);
        let t;
        try { t = await this.rpc.getRawTransactionVerbose(ct); }
        catch (err) {
          if (err instanceof RpcCallError && err.code === -5) continue;     // the node doesn't have it
          return { kind: 'wait', why: `node unreachable while checking candidate spender ${ct}` };
        }
        if (!t.vin.some((x) => x.txid === txid && x.vout === vout)) continue;   // the node says it doesn't spend it
        const outs = t.vout.map((o) => ({ valueSat: BigInt(Math.round(o.value * 1e8)), script: o.scriptPubKey.hex }));
        if (ours.has(outKey(outs))) {
          return { kind: 'none', why: `${ct} spends it with the same outputs as a payout of this withdrawal (a malleated copy)` };
        }
        const confs = t.confirmations ?? 0;
        if (confs >= SPENDER_MIN_CONFIRMATIONS) return { kind: 'ok', why: `${ct} (${confs} confirmations) spends it` };
        waitWhy = `the tx spending ${txid}:${vout} (${ct}) has ${confs} confirmation(s); waiting for ${SPENDER_MIN_CONFIRMATIONS}`;
      }
    }
    return waitWhy ? { kind: 'wait', why: waitWhy } : { kind: 'none', why: 'no tx the node has and the bridge signed spends it' };
  }

  /** Null if the burn on Gnosis backs this payout exactly; else why not (defer = retry later). */
  private async _burnNotBackedReason(row: QueuedPayoutRow): Promise<{ defer: boolean; reason: string } | null> {
    if (row.withdrawal_id === null || row.sender_address === null || row.wr_amount_sat === null) {
      return { defer: false, reason: 'burn check failed: no withdrawal_requests row for this order' };
    }
    if (row.same_burn_rows > 0) {
      return { defer: false, reason: `burn check failed: ${row.same_burn_rows} other withdrawal row(s) claim withdrawalId ${row.withdrawal_id}` };
    }
    if (row.wr_amount_sat !== row.amount_sat || row.wr_dobbscoin_address !== row.dobbscoin_address) {
      return { defer: false, reason: 'burn check failed: order and withdrawal rows disagree on amount or destination' };
    }
    const v = await this.burnVerifier.verify({
      withdrawalId: row.withdrawal_id, burnTxHash: row.burn_tx_hash, senderAddress: row.sender_address,
      amountSat: row.amount_sat, dobbscoinAddress: row.dobbscoin_address,
    });
    return v.ok ? null : { defer: v.defer, reason: v.reason };
  }

  // (review round 11) A payout that keeps waiting must not wait silently.
  private readonly deferSince = new Map<string, number>();
  private readonly deferAlerted = new Set<string>();
  private async _noteDefer(orderId: string, reason: string): Promise<void> {
    const first = this.deferSince.get(orderId) ?? Date.now();
    this.deferSince.set(orderId, first);
    if (Date.now() - first < 60 * 60_000 || this.deferAlerted.has(orderId)) return;
    this.deferAlerted.add(orderId);
    await this._alertCritical(`Payout for order ${orderId} has been waiting ${Math.round((Date.now() - first) / 60_000)} min: ${reason}`,
      { orderId, reason }, 'PAYOUT_DEFERRED');
  }
  private _clearDefer(orderId: string): void { this.deferSince.delete(orderId); this.deferAlerted.delete(orderId); }

  // (review round 11) Every withdrawal the DB calls done must have a payout our
  // node has confirmed; a DB writer marking an unpaid burn COMPLETED/FAILED
  // would otherwise hide it for good (terminal states are excluded from every
  // other check). Every 6 h; one alert per withdrawal per process.
  private lastPaidCheck = 0;
  private readonly unpaidAlerted = new Set<string>();
  async checkTerminalWithdrawalsPaid(): Promise<void> {
    if (Date.now() - this.lastPaidCheck < 6 * 3600_000) return;
    this.lastPaidCheck = Date.now();
    const rows = await this.sql<{ order_id: string; state: string; withdrawal_id: string }[]>`
      SELECT bo.id::text AS order_id, bo.state, wr.withdrawal_id::text AS withdrawal_id
      FROM bridge_orders bo JOIN withdrawal_requests wr ON wr.order_id = bo.id
      WHERE bo.order_type = 'outbound' AND bo.state IN ('COMPLETED', 'FAILED')
    `;
    for (const r of rows) {
      if (this.unpaidAlerted.has(r.withdrawal_id)) continue;
      const signed = await this.sql<{ hex: string | null; txid: string | null }[]>`
        SELECT metadata->>'signedHex' AS hex, metadata->>'txid' AS txid FROM audit_events a
        WHERE a.event_type IN ('PAYOUT_SIGNED', 'PAYOUT_BROADCAST', 'PAYOUT_SENT_OUT_OF_STATE')
          AND (a.metadata->>'withdrawalId' = ${r.withdrawal_id}
               OR a.order_id IN (SELECT o.order_id FROM audit_events o
                                 WHERE o.event_type = 'ORDER_CREATED' AND o.metadata->>'withdrawalId' = ${r.withdrawal_id}
                                 UNION SELECT ${r.order_id}::uuid))
      `;
      const ids = new Set<string>();
      for (const e of signed) { try { if (e.hex) ids.add(txidFromRawHex(e.hex)); else if (e.txid) ids.add(e.txid.toLowerCase()); } catch { /* skip */ } }
      let paid = false;
      for (const t of ids) {
        const c = await this.rpc.getConfirmations(t).catch(() => null);
        if (c === null) return;                     // node trouble: try again next round, no false alarm
        if (c >= 1) { paid = true; break; }
      }
      if (!paid) {
        this.unpaidAlerted.add(r.withdrawal_id);
        await this._alertCritical(`Withdrawal ${r.withdrawal_id} (order ${r.order_id}) is ${r.state} but no payout for it is confirmed on our ` +
          `Dobbscoin node: a burned withdrawal may be unpaid (or the DB was edited). Check it by hand.`,
          { orderId: r.order_id, withdrawalId: r.withdrawal_id }, 'BURN_UNPAID');
      }
    }
  }

  private async _alertCritical(message: string, data: Record<string, unknown>, type: Alert['type'] = 'MANUAL_REVIEW_ORDERS'): Promise<void> {
    try {
      await new AlertDispatcher({ webhookUrl: this.config.alertWebhookUrl, emailTo: this.config.alertEmailTo }).dispatch({
        level: 'critical', type, timestamp: new Date().toISOString(), message, data,
      });
    } catch (err) {
      console.error('[payout-executor] alert dispatch failed:', err);
    }
  }

  private async _buildAndSignPayout(
    row: QueuedPayoutRow,
    alive: { txid: string; inputs: { txid: string; vout: number }[]; optional?: boolean }[] = [],
    seenMaxAuditId: bigint = 0n,
  ): Promise<void> {
    // Fetch available UTXOs
    const utxoRows = await this.sql<BridgeUtxoRow[]>`
      SELECT id, txid, vout, amount_sat, address, hd_index, derivation_path
      FROM bridge_utxos
      WHERE status = 'available'
      ORDER BY amount_sat DESC
    `;

    if (utxoRows.length === 0) {
      throw new Error('No available bridge UTXOs for payout');
    }

    const utxos: UtxoInput[] = utxoRows.map((u) => ({
      txid:      u.txid,
      vout:      u.vout,
      amountSat: u.amount_sat,
      hdIndex:   u.hd_index,
      isChange:  u.derivation_path === 'change',
    }));

    // Allocate the next change index from DB (not an in-memory counter — that
    // resets on restart and would reuse the same change address, and also
    // desyncs across multiple backend instances).
    // Also skips indexes held by signed-not-yet-broadcast refunds.
    // (review round 11) Spend a coin of every earlier attempt that is still a
    // valid signed tx, so the new payout and it can never both confirm. If none
    // of its coins is free (another signed tx holds them), wait: that holder
    // either confirms (and the old attempt is dead, see _knownSpender) or is
    // released.
    const required: UtxoInput[] = [];
    for (const e of alive) {
      const mine = utxos.filter((u) => e.inputs.some((i) => i.txid === u.txid && i.vout === u.vout));
      if (mine.length === 0) {
        if (e.optional) continue;          // a dead attempt: only spent when a coin happens to be free
        throw new EarlierPayoutBusyError(e.txid);
      }
      if (!mine.some((m) => required.some((r) => r.txid === m.txid && r.vout === m.vout))) {
        required.push(mine.reduce((a, b) => (b.amountSat > a.amountSat ? b : a)));
      }
    }

    const changeIndex = await nextChangeIndex(this.sql);
    const changeAddress = this.txBuilder.deriveChangeAddress(changeIndex);

    const result = await this.txBuilder.buildPayoutTx(
      utxos,
      row.amount_sat,
      row.dobbscoin_address,
      changeAddress,
      this.config.dobbscoinFeeRateSatPerVbyte,
      this.rpc,
      required,
    );
    for (const e of alive) {
      if (e.optional) continue;
      if (!result.inputs.some((u) => e.inputs.some((i) => i.txid === u.txid && i.vout === u.vout))) {
        throw new Error(`refusing to sign: the new payout does not conflict with earlier payout ${e.txid}`);
      }
    }

    // Atomically: reserve UTXOs, create payout row, advance FSM
    await this.sql.begin(async (tx) => {
      // (review round 11) One signer per withdrawal at a time, and nobody signed
      // for it since our already-paid check: else start over next poll.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'wbob-withdrawal:' + row.withdrawal_id}))`;
      const [newer] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_events a
        WHERE a.id > ${seenMaxAuditId.toString()}
          AND a.event_type IN ('PAYOUT_SIGNED', 'PAYOUT_SENT_OUT_OF_STATE', 'PAYOUT_BROADCAST')
          AND (a.metadata->>'withdrawalId' = ${row.withdrawal_id}
               OR a.order_id IN (SELECT o.order_id FROM audit_events o
                                 WHERE o.event_type = 'ORDER_CREATED' AND o.metadata->>'withdrawalId' = ${row.withdrawal_id}
                                 UNION SELECT ${row.order_id}::uuid))
      `;
      if (newer && newer.n > 0) throw new UtxoRaceError(`a payout for withdrawalId ${row.withdrawal_id} was signed meanwhile`);
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_QUEUED) return;

      // Get withdrawal_request id
      const wrRows = await tx<{ id: string }[]>`
        SELECT id FROM withdrawal_requests WHERE order_id = ${row.order_id}
      `;
      if (wrRows.length === 0) throw new Error('No withdrawal_request row');
      const wrId = wrRows[0]!.id;

      // Create the payout row, or reuse it when re-signing after a release
      // (withdrawal_request_id is UNIQUE: one payout row per withdrawal).
      let payoutId: string;
      if (row.payout_id !== null) {
        const held = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM bridge_utxos WHERE spent_payout_id = ${row.payout_id}
        `;
        const upd = await tx<{ id: string }[]>`
          UPDATE payouts SET fee_sat = ${result.feeSat.toString()}, updated_at = now()
          WHERE id = ${row.payout_id} AND txid IS NULL
          RETURNING id
        `;
        // Re-check under the order lock: nothing may still point at the old tx.
        if (held[0]!.n !== 0 || upd.length !== 1) throw new Error(`re-sign refused: payout ${row.payout_id} changed`);
        payoutId = row.payout_id;
      } else {
        const payoutRows = await tx<{ id: string }[]>`
          INSERT INTO payouts (withdrawal_request_id, dobbscoin_address, amount_sat, fee_sat)
          VALUES (${wrId}, ${row.dobbscoin_address}, ${row.amount_sat}, ${result.feeSat})
          RETURNING id
        `;
        payoutId = payoutRows[0]!.id;
      }

      // Store signed_hex in metadata (reuse payout row via separate update — no raw_hex column yet)
      // We store it in audit_events metadata temporarily until broadcast
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${row.order_id},
          'PAYOUT_SIGNED',
          ${OutboundState.PAYOUT_QUEUED},
          ${OutboundState.PAYOUT_SIGNED},
          'payout-executor',
          ${tx.json({
            payoutId,
            // (review round 10 #1) so every payout of a withdrawal can be found by its id,
            // whatever order row it was made on
            withdrawalId: row.withdrawal_id,
            txid: result.txid,
            signedHex: result.rawHex,
            feeSat: result.feeSat.toString(),
            changeSat: result.changeSat.toString(),
            changeAddress: result.changeSat > 0n ? changeAddress : null,
            changeIndex:   result.changeSat > 0n ? changeIndex   : null,
          })}
        )
      `;

      // Reserve UTXOs used in this tx
      const usedTxids = result.inputs.map((u) => u.txid);
      const usedVouts = result.inputs.map((u) => u.vout);
      for (let i = 0; i < usedTxids.length; i++) {
        const got = await tx`
          UPDATE bridge_utxos
          SET status = 'reserved', spent_payout_id = ${payoutId}, updated_at = now()
          WHERE txid = ${usedTxids[i]!} AND vout = ${usedVouts[i]!} AND status = 'available'
          RETURNING id
        `;
        // Someone reserved/spent it since selection: roll back and retry next poll.
        if (got.length !== 1) throw new UtxoRaceError(`${usedTxids[i]}:${usedVouts[i]}`);
      }

      await tx`
        UPDATE bridge_orders SET state = ${OutboundState.PAYOUT_SIGNED}, updated_at = now()
        WHERE id = ${row.order_id}
      `;
    });

    console.log(`[payout-executor] signed payout orderId=${row.order_id} fee=${result.feeSat}`);
  }

  // ── Job 2: PAYOUT_SIGNED → PAYOUT_BROADCAST ──────────────────────────────

  private async broadcastSigned(): Promise<void> {
    // The NEWEST signed hex recorded for each payout row. A payout re-signed
    // after a release has older PAYOUT_SIGNED rows whose inputs may be reused
    // elsewhere; sending one of those could pay the recipient twice.
    const signed = await this.sql<SignedPayoutRow[]>`
      SELECT DISTINCT ON (p.id)
        bo.id AS order_id,
        p.id  AS payout_id,
        (ae.metadata->>'signedHex')     AS signed_hex,
        (ae.metadata->>'changeSat')     AS change_sat,
        (ae.metadata->>'changeAddress') AS change_address,
        (ae.metadata->>'changeIndex')   AS change_index
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      JOIN payouts p ON p.withdrawal_request_id = wr.id
      JOIN audit_events ae ON ae.order_id = bo.id AND ae.event_type = 'PAYOUT_SIGNED'
                          AND ae.metadata->>'payoutId' = p.id::text
      WHERE bo.state = ${OutboundState.PAYOUT_SIGNED}
        AND p.txid IS NULL
      ORDER BY p.id, ae.id DESC
    `;

    for (const row of signed) {
      if (!row.signed_hex) continue;
      const expectedTxid = txidFromRawHex(row.signed_hex);
      let hist: { thisTx: number; sinceRetry: number; retried: boolean };
      try {
        hist = await this._recordBroadcastAttempt(row.order_id, row.payout_id, expectedTxid);
      } catch (err) {
        console.error(`[payout-executor] could not record broadcast attempt orderId=${row.order_id}; not sending:`, err);
        continue;
      }

      // 1. Send. A failure here is the NODE's answer, never a DB error.
      let sendErr: unknown = null;
      let nodeTxid: string | null = null;
      try {
        nodeTxid = await this.rpc.sendRawTransaction(row.signed_hex);
      } catch (err) {
        sendErr = err;
      }

      if (nodeTxid !== null) {
        if (nodeTxid !== expectedTxid) {
          console.error(`[payout-executor] CRITICAL: node returned txid ${nodeTxid}, computed ${expectedTxid} ` +
            `(orderId=${row.order_id}); recording the node's`);
        }
        // 2. Record it. If this fails the tx is still out there: the next poll
        // re-sends the same tx (0.14 returns the hash for a mempool tx) and retries the commit.
        try {
          await this._commitBroadcast(row, nodeTxid, {});
          console.log(`[payout-executor] broadcast txid=${nodeTxid} orderId=${row.order_id}`);
        } catch (err) {
          console.error(`[payout-executor] broadcast txid=${nodeTxid} accepted but not recorded (orderId=${row.order_id}); retrying next poll:`, err);
        }
        continue;
      }
      console.error(`[payout-executor] send failed orderId=${row.order_id}:`, sendErr);

      // 3. Lost acknowledgement? Does the node hold this exact tx anyway?
      const has = await this._nodeHas(expectedTxid);
      const alreadyInChain = sendErr instanceof RpcCallError && sendErr.code === -27;
      if (alreadyInChain || has === 'mempool' || has === 'chain') {
        try {
          await this._commitBroadcast(row, expectedTxid, {
            ackLost: true, nodeHas: alreadyInChain ? 'chain' : has, sendError: String(sendErr),
          });
          console.warn(`[payout-executor] send ack lost orderId=${row.order_id}; node has txid=${expectedTxid}, recorded as broadcast`);
        } catch (err) {
          console.error(`[payout-executor] could not record ack-lost broadcast orderId=${row.order_id}; retrying next poll:`, err);
        }
        continue;
      }

      // 4. Refused outright. A refusal proves THIS send was not accepted, so
      // record it. If no earlier send of this tx may have reached the network
      // and it was never operator-retried, and the node confirms it does not
      // hold it, its inputs are still ours: free them.
      if (isDefiniteRejection(sendErr)) {
        await this._recordRefusal(row.order_id, row.payout_id, expectedTxid, String(sendErr));
        if (hist.thisTx === 0 && !hist.retried) {
          if (has === 'no') {
            await this._parkAndRelease(row.order_id, row.payout_id, String(sendErr));
            continue;
          }
          if (has === null) {
            console.warn(`[payout-executor] refused orderId=${row.order_id}, node lookup failed; deciding next poll`);
            continue;     // stays PAYOUT_SIGNED; the refusal row keeps it eligible
          }
        }
      }

      // 5. Retryable (node down/busy, input not visible yet, mempool limits):
      // re-send the same tx next poll.
      if (isTransient(sendErr) && hist.sinceRetry + 1 < MAX_SEND_ATTEMPTS) {
        console.warn(`[payout-executor] retryable send failure orderId=${row.order_id} ` +
          `(attempt ${hist.sinceRetry + 1}/${MAX_SEND_ATTEMPTS}); will re-send the same tx`);
        continue;
      }

      // 6. Park, inputs held: the tx may be on peers, or its inputs spent elsewhere.
      try {
        await this._transitionOutbound(
          row.order_id, OutboundState.PAYOUT_SIGNED, OutboundState.MANUAL_REVIEW,
          {
            error: String(sendErr),
            txid: expectedTxid,
            inputsHeld: isDefiniteRejection(sendErr)
              ? 'node refused it, but it may have been sent before (earlier attempts or an operator retry): ' +
                'its reserved UTXOs are HELD. Confirm the tx is on no node before releasing them by hand.'
              : 'the tx may be on the network: reserved UTXOs kept',
            retry: "set state='PAYOUT_QUEUED' to re-send this same signed tx (safe: identical tx)",
          },
        );
      } catch (err) {
        console.error(`[payout-executor] park error orderId=${row.order_id}:`, err);
      }
    }
  }

  /** Record a payout as broadcast: txid, inputs spent, change ingested, state advanced. */
  private async _commitBroadcast(row: SignedPayoutRow, txid: string, extra: Record<string, unknown>): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${row.order_id} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_SIGNED) {
        // The node HAS this tx, but the order moved meanwhile (another poller
        // parked it, or a hand edit). The coins are spent either way: record
        // that, never leave them 'available'.
        await tx`UPDATE payouts SET txid = ${txid}, broadcast_at = now(), updated_at = now() WHERE id = ${row.payout_id}`;
        await tx`UPDATE bridge_utxos SET status = 'spent', updated_at = now() WHERE spent_payout_id = ${row.payout_id}`;
        // Inputs may have been released meanwhile (spent_payout_id cleared): mark
        // the outpoints this tx ACTUALLY spends, read from the signed hex.
        let inputs: { txid: string; vout: number }[] = [];
        try { inputs = txInputsFromRawHex(row.signed_hex); }
        catch (err) { console.error(`[payout-executor] cannot parse inputs of payout ${row.payout_id}:`, err); }
        for (const inp of inputs) {
          await tx`UPDATE bridge_utxos SET status = 'spent', spent_payout_id = ${row.payout_id}, updated_at = now()
                   WHERE txid = ${inp.txid} AND vout = ${inp.vout}`;
        }
        if (row.change_sat && BigInt(row.change_sat) > 0n && row.change_address && row.change_index !== null) {
          await tx`
            INSERT INTO bridge_utxos (order_id, txid, vout, amount_sat, address, hd_index, derivation_path, status)
            VALUES (${row.order_id}, ${txid}, 1, ${BigInt(row.change_sat).toString()}, ${row.change_address},
                    ${parseInt(row.change_index, 10)}, 'change', 'available')
            ON CONFLICT (txid, vout) DO NOTHING
          `;
        }
        await tx`
          INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
          VALUES (${row.order_id}, 'PAYOUT_SENT_OUT_OF_STATE', ${rows[0]?.state ?? null}, ${rows[0]?.state ?? 'UNKNOWN'},
                  'payout-executor', ${tx.json({ txid, payoutId: row.payout_id, ...extra } as never)})
        `;
        console.error(`[payout-executor] CRITICAL: payout txid=${txid} is on the network but order ${row.order_id} is ` +
          `${rows[0]?.state ?? 'missing'}; recorded the txid and marked inputs spent. Reconcile by hand.`);
        return;
      }

      await tx`
        UPDATE payouts SET txid = ${txid}, broadcast_at = now(), updated_at = now()
        WHERE id = ${row.payout_id}
      `;
      await tx`
        UPDATE bridge_utxos SET status = 'spent', updated_at = now()
        WHERE spent_payout_id = ${row.payout_id}
      `;

      // Ingest the change output as a new spendable UTXO. Convention: the
      // tx-builder always places change at vout=1 (recipient is vout=0),
      // and emits no change output when changeSat <= dust threshold.
      if (row.change_sat && BigInt(row.change_sat) > 0n
          && row.change_address && row.change_index !== null) {
        await tx`
          INSERT INTO bridge_utxos
            (order_id, txid, vout, amount_sat, address, hd_index, derivation_path, status)
          VALUES
            (${row.order_id}, ${txid}, 1, ${BigInt(row.change_sat)},
             ${row.change_address}, ${parseInt(row.change_index, 10)},
             'change', 'available')
          ON CONFLICT (txid, vout) DO NOTHING
        `;
      }

      await tx`
        UPDATE bridge_orders SET state = ${OutboundState.PAYOUT_BROADCAST}, updated_at = now()
        WHERE id = ${row.order_id}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${row.order_id}, 'STATE_TRANSITION',
          ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.PAYOUT_BROADCAST},
          'payout-executor', ${tx.json({ txid, ...extra } as never)}
        )
      `;
    });
  }

  // ── Job 3: PAYOUT_BROADCAST → PAYOUT_CONFIRMED → COMPLETED ───────────────

  private async confirmBroadcast(): Promise<void> {
    const broadcast = await this.sql<BroadcastPayoutRow[]>`
      SELECT bo.id AS order_id, p.id AS payout_id, p.txid, p.broadcast_at
      FROM bridge_orders bo
      JOIN withdrawal_requests wr ON wr.order_id = bo.id
      JOIN payouts p ON p.withdrawal_request_id = wr.id
      WHERE bo.state = ${OutboundState.PAYOUT_BROADCAST}
        AND p.txid IS NOT NULL
      ORDER BY p.broadcast_at ASC NULLS FIRST   -- parents before children (change chains)
    `;

    for (const row of broadcast) {
      let confs: number;
      try { confs = await this.rpc.getConfirmations(row.txid); } catch { continue; /* node unreachable */ }
      if (confs === -1) { await this._resendForgotten(row); continue; }
      if (confs === 0) {
        // 0 is also what a tx only in a stale (reorged-out) block reports.
        let inPool: boolean | null = null;
        try { inPool = await this.rpc.isInMempool(row.txid); } catch { /* unreachable */ }
        if (inPool === false) await this._resendForgotten(row);
        continue;
      }
      if (confs < PAYOUT_MIN_CONFIRMATIONS) continue;
      this.resendState.delete(row.payout_id);

      await this._transitionOutbound(
        row.order_id, OutboundState.PAYOUT_BROADCAST, OutboundState.PAYOUT_CONFIRMED,
        { txid: row.txid, confirmations: confs },
      );

      await this.sql`
        UPDATE payouts SET confirmed_at = now(), confirmations = ${confs}, updated_at = now()
        WHERE id = ${row.payout_id}
      `;

      await this._transitionOutbound(
        row.order_id, OutboundState.PAYOUT_CONFIRMED, OutboundState.COMPLETED,
        { txid: row.txid },
      );

      console.log(`[payout-executor] payout confirmed txid=${row.txid} orderId=${row.order_id}`);
    }
  }

  /**
   * The node no longer knows a payout we broadcast (evicted from the mempool,
   * node restarted, never relayed). Re-send the SAME signed tx (safe: same
   * txid, same inputs). If its inputs are gone (-25), they were spent by a
   * different tx (a conflict or a malleated copy): park for a human.
   */
  private async _resendForgotten(row: BroadcastPayoutRow): Promise<void> {
    const since = row.broadcast_at ? Date.now() - row.broadcast_at.getTime() : Infinity;
    if (since < RESEND_FORGOTTEN_AFTER_MS) return;
    const st = this.resendState.get(row.payout_id) ?? { last: 0, failures: 0 };
    if (Date.now() - st.last < RESEND_FORGOTTEN_AFTER_MS) return;
    st.last = Date.now();
    this.resendState.set(row.payout_id, st);

    const hexRows = await this.sql<{ signed_hex: string | null }[]>`
      SELECT ae.metadata->>'signedHex' AS signed_hex FROM audit_events ae
      WHERE ae.order_id = ${row.order_id} AND ae.event_type = 'PAYOUT_SIGNED'
        AND ae.metadata->>'payoutId' = ${row.payout_id}
      ORDER BY ae.id DESC
    `;
    const hexes = hexRows.map((r) => r.signed_hex).filter((h): h is string => h !== null);
    // Only the hex whose txid IS the recorded one. Sending any other tx would
    // never make the recorded txid confirm (and could be a different payment).
    const hex = hexes.find((h) => txidFromRawHex(h) === row.txid);
    if (!hex) {
      this.resendState.delete(row.payout_id);
      await this._park(row.order_id, OutboundState.PAYOUT_BROADCAST,
        `broadcast payout ${row.txid} is unknown to the node and no stored signed tx has that txid: reconcile by hand`);
      return;
    }
    try {
      await this.rpc.sendRawTransaction(hex);
      st.failures = 0;
      console.warn(`[payout-executor] node had forgotten payout txid=${row.txid}; re-sent it (orderId=${row.order_id})`);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === -27) { st.failures = 0; return; }   // in the chain after all
      // Node unreachable/warming up says nothing about the tx: don't count it.
      if (err instanceof RpcNetworkError || (err instanceof RpcCallError && err.code === -28)) return;
      // -25 can mean "inputs spent by a different tx" OR "parent payout's change
      // is forgotten too" (it gets re-sent first, ordering is oldest-first). Only
      // a refusal that persists means a human has to look.
      st.failures += 1;
      console.error(`[payout-executor] re-send of forgotten payout txid=${row.txid} refused ` +
        `(${st.failures}/${RESEND_FORGOTTEN_MAX_FAILURES}):`, err);
      if (st.failures < RESEND_FORGOTTEN_MAX_FAILURES) return;
      this.resendState.delete(row.payout_id);
      try {
        await this._transitionOutbound(row.order_id, OutboundState.PAYOUT_BROADCAST, OutboundState.MANUAL_REVIEW, {
          error: String(err), txid: row.txid,
          note: 'broadcast payout is unknown to the node and keeps being refused on re-send (conflict, a malleated ' +
                'copy, or fee policy): check whether the recipient was paid before doing anything',
        });
      } catch (e2) {
        console.error(`[payout-executor] park error orderId=${row.order_id}:`, e2);
      }
    }
  }

  /**
   * Does our node hold this exact tx? 'mempool' | 'chain' | 'no' | null (node
   * unreachable). confirmations 0 alone is NOT enough: a tx only in a stale,
   * reorged-out block also reports 0, so check the mempool itself.
   */
  private async _nodeHas(txid: string): Promise<'mempool' | 'chain' | 'no' | null> {
    try {
      const confs = await this.rpc.getConfirmations(txid);
      if (confs >= 1) return 'chain';
      if (confs === -1) return 'no';
      return (await this.rpc.isInMempool(txid)) ? 'mempool' : 'no';
    } catch {
      return null;
    }
  }

  /** Record that the node definitively refused this exact tx (it was not accepted, so not relayed by this send). */
  private async _recordRefusal(orderId: string, payoutId: string, txid: string, error: string): Promise<void> {
    try {
      await this.sql`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (${orderId}, 'PAYOUT_BROADCAST_REFUSED', ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.PAYOUT_SIGNED},
                'payout-executor', ${this.sql.json({ payoutId, txid, error })})
      `;
    } catch (err) {
      console.error(`[payout-executor] could not record refusal orderId=${orderId}:`, err);
    }
  }

  /** Park in MANUAL_REVIEW with a reason, logging instead of throwing. */
  private async _park(orderId: string, from: OutboundState, reason: string): Promise<void> {
    console.error(`[payout-executor] orderId=${orderId}: ${reason}`);
    try {
      await this._transitionOutbound(orderId, from, OutboundState.MANUAL_REVIEW, { error: reason });
    } catch (err) {
      console.error(`[payout-executor] park error orderId=${orderId}:`, err);
    }
  }

  /** Like _transitionOutbound, with a custom audit event type. */
  private async _transitionGeneric(
    orderId: string, from: OutboundState, to: OutboundState, eventType: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    assertOutboundTransition(from, to);
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE`;
      if (rows.length === 0 || rows[0]!.state !== from) return;
      await tx`UPDATE bridge_orders SET state = ${to}, updated_at = now() WHERE id = ${orderId}`;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (${orderId}, ${eventType}, ${from}, ${to}, 'payout-executor', ${tx.json(metadata as never)})
      `;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Append a PAYOUT_BROADCAST_ATTEMPT audit row for this exact tx and report the
   * history before it (under the order lock, so concurrent pollers serialize):
   *   thisTx      attempts of this txid that MAY have reached the network: all
   *               attempts (plus legacy txid-less rows written before 2026-11-06)
   *               minus the ones the node definitively refused
   *   sinceRetry  attempts of this txid since the last operator RETRY_SAME_TX
   *   retried     whether this payout was ever re-queued by an operator
   */
  private async _recordBroadcastAttempt(orderId: string, payoutId: string, txid: string):
    Promise<{ thisTx: number; sinceRetry: number; retried: boolean }> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM bridge_orders WHERE id = ${orderId} FOR UPDATE`;
      const [h] = await tx<{ this_tx: number; since_retry: number; retried: boolean }[]>`
        WITH refused AS (
          SELECT count(*)::int AS n FROM audit_events
          WHERE order_id = ${orderId} AND event_type = 'PAYOUT_BROADCAST_REFUSED'
            AND metadata->>'payoutId' = ${payoutId} AND metadata->>'txid' = ${txid}
        ), last_retry AS (
          SELECT COALESCE(MAX(id), 0) AS id FROM audit_events
          WHERE order_id = ${orderId} AND event_type = 'RETRY_SAME_TX' AND metadata->>'payoutId' = ${payoutId}
        )
        SELECT
          -- attempts that MAY have reached the network: all attempts of this tx
          -- (and legacy txid-less ones) minus those the node definitively refused
          (count(*) FILTER (WHERE metadata->>'txid' = ${txid} OR metadata->>'txid' IS NULL)
             - (SELECT n FROM refused))::int AS this_tx,
          count(*) FILTER (WHERE metadata->>'txid' = ${txid} AND id > (SELECT id FROM last_retry))::int AS since_retry,
          (SELECT id FROM last_retry) > 0 AS retried
        FROM audit_events
        WHERE order_id = ${orderId} AND event_type = 'PAYOUT_BROADCAST_ATTEMPT' AND metadata->>'payoutId' = ${payoutId}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (${orderId}, 'PAYOUT_BROADCAST_ATTEMPT', ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.PAYOUT_SIGNED},
                'payout-executor', ${tx.json({ payoutId, txid, attempt: h!.this_tx + 1 })})
      `;
      return { thisTx: h!.this_tx, sinceRetry: h!.since_retry, retried: h!.retried };
    });
  }

  /** PAYOUT_SIGNED → MANUAL_REVIEW and return this payout's reserved inputs to the pool, atomically. */
  private async _parkAndRelease(orderId: string, payoutId: string, error: string): Promise<void> {
    assertOutboundTransition(OutboundState.PAYOUT_SIGNED, OutboundState.MANUAL_REVIEW);
    try {
      await this.sql.begin(async (tx) => {
        const rows = await tx<{ state: string }[]>`
          SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
        `;
        if (rows.length === 0 || rows[0]!.state !== OutboundState.PAYOUT_SIGNED) return;
        const released = await tx<{ txid: string; vout: number }[]>`
          UPDATE bridge_utxos SET status = 'available', spent_payout_id = NULL, updated_at = now()
          WHERE spent_payout_id = ${payoutId} AND status = 'reserved'
          RETURNING txid, vout
        `;
        await tx`
          UPDATE bridge_orders SET state = ${OutboundState.MANUAL_REVIEW}, updated_at = now() WHERE id = ${orderId}
        `;
        await tx`
          INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
          VALUES (
            ${orderId}, 'STATE_TRANSITION', ${OutboundState.PAYOUT_SIGNED}, ${OutboundState.MANUAL_REVIEW},
            'payout-executor',
            ${tx.json({ error, rejectedByNode: true, utxosReleased: released.map((u) => `${u.txid}:${u.vout}`) })}
          )
        `;
        console.error(`[payout-executor] node rejected payout orderId=${orderId}; released ${released.length} reserved UTXO(s)`);
      });
    } catch (err) {
      console.error(`[payout-executor] park+release error orderId=${orderId}:`, err);
    }
  }

  private async _transitionOutbound(
    orderId: string,
    from: OutboundState,
    to: OutboundState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    assertOutboundTransition(from, to);
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
      `;
      if (rows.length === 0 || rows[0]!.state !== from) return;
      await tx`
        UPDATE bridge_orders SET state = ${to}, updated_at = now() WHERE id = ${orderId}
      `;
      await tx`
        INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
        VALUES (
          ${orderId}, 'STATE_TRANSITION', ${from}, ${to},
          'payout-executor', ${tx.json(metadata)}
        )
      `;
    });
  }
}
