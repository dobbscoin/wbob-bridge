/**
 * GET /v1/mint-cap — today's wBOB mint cap, as the bridge will apply it.
 *
 * The portal's deposit page shows the cap, how much of it is used, what is
 * left, and a countdown to the reset. "Left" here is what the NEXT deposit can
 * mint: the chain's remaining allowance minus the mints the bridge has already
 * authorized but not yet executed — the same number the mint executor splits
 * deposits against (backend/src/executor/mint-capacity.ts).
 *
 * Cached briefly: every open deposit page polls this.
 */

import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  availableCapacity,
  computeCapWindow,
  outstandingReservedSat,
  type MintCapReader,
} from '../../executor/mint-capacity.js';

export interface MintCapResponse {
  limitSat:          string;
  /** Minted on-chain in the current window (0 if the window has lapsed). */
  mintedTodaySat:    string;
  /** Authorized by the bridge, not yet executed — will count against today. */
  reservedSat:       string;
  /** What the next deposit can mint right now: limit − minted − reserved (≥ 0). */
  remainingSat:      string;
  windowStale:       boolean;
  windowStart:       string;   // ISO
  resetsAt:          string;   // ISO — 00:00 UTC for the contract's aligned window
  gnosisBlock:       string;
  checkedAt:         string;   // ISO
}

const CACHE_MS = 15_000;

export async function mintCapRoute(
  fastify: FastifyInstance,
  opts: { sql: Sql; capReader: MintCapReader },
): Promise<void> {
  let cached: { at: number; body: MintCapResponse } | null = null;
  let inflight: Promise<MintCapResponse> | null = null;

  async function load(): Promise<MintCapResponse> {
    const state = await opts.capReader.readState();
    const window = computeCapWindow(state);
    const reserved = await outstandingReservedSat(opts.sql, opts.capReader, state);
    const iso = (sec: bigint) => new Date(Number(sec) * 1000).toISOString();
    return {
      limitSat:       window.limitSat.toString(),
      mintedTodaySat: window.mintedTodaySat.toString(),
      reservedSat:    reserved.toString(),
      remainingSat:   availableCapacity(window, reserved).toString(),
      windowStale:    window.windowStale,
      windowStart:    iso(window.windowStartSec),
      resetsAt:       iso(window.resetsAtSec),
      gnosisBlock:    state.blockNumber.toString(),
      checkedAt:      new Date().toISOString(),
    };
  }

  fastify.get('/v1/mint-cap', async (_request, reply) => {
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return reply.header('Cache-Control', 'public, max-age=15').send(cached.body);
    }
    try {
      inflight ??= load();
      const body = await inflight;
      cached = { at: Date.now(), body };
      return reply.header('Cache-Control', 'public, max-age=15').send(body);
    } catch (err) {
      fastify.log.error({ err }, 'mint-cap read failed');
      if (cached) return reply.header('X-Stale', '1').send(cached.body);
      return reply.status(503).send({ error: 'Mint cap unavailable — Gnosis read failed' });
    } finally {
      inflight = null;
    }
  });
}
