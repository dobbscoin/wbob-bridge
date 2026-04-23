/**
 * FSM execution engine — DB-aware transition executor.
 *
 * Takes a validated transition (from the pure FSM) and persists it atomically:
 *   1. SELECT FOR UPDATE on the order row (prevent concurrent transitions)
 *   2. Validate the transition is still valid (re-check current state)
 *   3. UPDATE bridge_orders.state
 *   4. INSERT into audit_events
 *
 * All four operations happen inside a single PostgreSQL transaction.
 * If any step fails, the entire transaction rolls back.
 */

import type { Sql, TransactionSql } from '../db/client.js';
import type { BridgeOrderRow, AuditEventRow } from '../db/schema.js';
import {
  InboundState,
  OutboundState,
  assertInboundTransition,
  InboundTransitionError,
  assertOutboundTransition,
  OutboundTransitionError,
} from '@wbob/shared';

export type AnyState = InboundState | OutboundState;

export interface TransitionOptions {
  /** Service or component initiating the transition (recorded in audit_events). */
  actor?: string;
  /** Arbitrary context to record alongside the transition. */
  metadata?: Record<string, unknown>;
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`Order not found: ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}

export class ConcurrentTransitionError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly expectedState: AnyState,
    public readonly actualState: AnyState,
  ) {
    super(
      `Concurrent transition detected on order ${orderId}: ` +
      `expected state ${expectedState} but found ${actualState}`,
    );
    this.name = 'ConcurrentTransitionError';
  }
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class FSMEngine {
  constructor(private readonly sql: Sql) {}

  /**
   * Transition an inbound order to a new state.
   * Throws InboundTransitionError if the transition is invalid.
   * Throws ConcurrentTransitionError if the order state changed between read and write.
   */
  async transitionInbound(
    orderId: string,
    expectedCurrentState: InboundState,
    toState: InboundState,
    opts: TransitionOptions = {},
  ): Promise<void> {
    // Validate before hitting the DB (fast fail)
    assertInboundTransition(expectedCurrentState, toState);

    await this.sql.begin(async (tx) => {
      await this._executeTransition(tx, orderId, expectedCurrentState, toState, opts);
    });
  }

  /**
   * Transition an outbound order to a new state.
   */
  async transitionOutbound(
    orderId: string,
    expectedCurrentState: OutboundState,
    toState: OutboundState,
    opts: TransitionOptions = {},
  ): Promise<void> {
    assertOutboundTransition(expectedCurrentState, toState);

    await this.sql.begin(async (tx) => {
      await this._executeTransition(tx, orderId, expectedCurrentState, toState, opts);
    });
  }

  /**
   * Fetch the current state of an order, acquiring a row lock.
   * For use inside an existing transaction when you need to read-then-write.
   */
  async lockOrder(
    tx: TransactionSql,
    orderId: string,
  ): Promise<BridgeOrderRow> {
    const rows = await tx<BridgeOrderRow[]>`
      SELECT * FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
    `;
    if (rows.length === 0) throw new OrderNotFoundError(orderId);
    return rows[0]!;
  }

  /** Append an audit event without changing state (for informational events). */
  async recordEvent(
    orderId: string,
    eventType: string,
    currentState: AnyState,
    metadata?: Record<string, unknown>,
    actor?: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (
        ${orderId},
        ${eventType},
        ${currentState},
        ${currentState},
        ${actor ?? null},
        ${metadata ? JSON.stringify(metadata) : null}
      )
    `;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _executeTransition(
    tx: TransactionSql,
    orderId: string,
    expectedFrom: AnyState,
    to: AnyState,
    opts: TransitionOptions,
  ): Promise<void> {
    // 1. Lock the row
    const rows = await tx<BridgeOrderRow[]>`
      SELECT id, state FROM bridge_orders WHERE id = ${orderId} FOR UPDATE
    `;
    if (rows.length === 0) throw new OrderNotFoundError(orderId);

    const current = rows[0]!.state;

    // 2. Re-validate current state (race condition guard)
    if (current !== expectedFrom) {
      throw new ConcurrentTransitionError(orderId, expectedFrom, current);
    }

    // 3. Update state
    await tx`
      UPDATE bridge_orders
      SET state = ${to}
      WHERE id = ${orderId}
    `;

    // 4. Append audit event
    await tx`
      INSERT INTO audit_events (order_id, event_type, from_state, to_state, actor, metadata)
      VALUES (
        ${orderId},
        'STATE_TRANSITION',
        ${String(expectedFrom)},
        ${String(to)},
        ${opts.actor ?? null},
        ${opts.metadata ? JSON.stringify(opts.metadata) : null}
      )
    `;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createEngine(sql: Sql): FSMEngine {
  return new FSMEngine(sql);
}
