/**
 * Block poller — tracks the chain tip and emits new / orphaned blocks.
 *
 * Delegates reorg detection to ReorgDetector.
 * Emits events by calling the provided callback handlers.
 *
 * On startup, catchUp() replays every block mined since a persisted cursor
 * (the last block the watcher finished) before steady-state polling begins.
 */

import type { DobbscoinRpcClient } from '../rpc/client.js';
import type { RpcBlock, BlockHeader } from '../rpc/types.js';
import { ReorgDetector } from './reorg-detector.js';

// ─── Events ───────────────────────────────────────────────────────────────────

export interface BlockPollerHandlers {
  /** Called for each new block added to the canonical chain, in height-asc order. */
  onBlock: (block: RpcBlock) => Promise<void>;
  /** Called for each block orphaned by a reorg, in height-desc order.
   *  Receives the header only (full block body not re-fetched for orphans). */
  onOrphan: (header: BlockHeader) => Promise<void>;
  /** Called when a polling cycle errors. Return true to stop the poller. */
  onError?: (err: unknown) => boolean | void;
}

/** The last block the watcher fully processed, as persisted in the DB. */
export interface BlockCursor {
  height: number;
  hash: string;
}

export interface CatchUpResult {
  /** Blocks replayed through onBlock. */
  replayed: number;
  /** Blocks passed to onOrphan (the cursor's branch lost a reorg). */
  orphaned: number;
  /** The node's tip when catch-up started. */
  tipHeight: number;
}

/** More blocks are pending than catchUp() is allowed to replay unattended. */
export class CatchUpTooFarError extends Error {
  constructor(
    readonly pending: number,
    readonly maxBlocks: number,
    readonly cursor: BlockCursor,
    readonly tipHeight: number,
  ) {
    super(
      `refusing to start: ${pending} blocks are pending since the last processed block ` +
      `(cursor height ${cursor.height}, node tip ${tipHeight}), more than the ` +
      `WATCHER_CATCHUP_MAX_BLOCKS limit of ${maxBlocks}. Raise the limit to replay them ` +
      `all (the watcher will take a while), or move the cursor deliberately.`,
    );
    this.name = 'CatchUpTooFarError';
  }
}

/** The node's tip is behind the cursor on the same chain: it is still syncing. */
export class NodeBehindCursorError extends Error {
  constructor(readonly cursor: BlockCursor, readonly tipHeight: number) {
    super(`node tip ${tipHeight} is behind the cursor at ${cursor.height}; waiting for the node to sync`);
    this.name = 'NodeBehindCursorError';
  }
}

// ─── BlockPoller ─────────────────────────────────────────────────────────────

export class BlockPoller {
  private tipHash: string | null = null;
  private reorgDetector: ReorgDetector;
  private running = false;

  constructor(
    private readonly rpc: DobbscoinRpcClient,
    private readonly handlers: BlockPollerHandlers,
    /** How deep a reorg window to maintain. */
    private readonly reorgDepth = 200,
  ) {
    this.reorgDetector = new ReorgDetector(reorgDepth);
  }

  /**
   * Replay everything mined since `cursor`, through the same onOrphan/onBlock
   * path as a normal poll, so blocks mined while the watcher was down are not
   * lost. Call once before start(); safe to call again after a failure (it
   * resets its state, so pass the cursor freshly re-read from the DB).
   *
   *  - cursor null (first deploy): nothing to replay from; bootstraps at the
   *    tip exactly as a first poll() does.
   *  - cursor on the active chain: replays cursor+1 .. tip, height-ascending.
   *  - cursor's block was orphaned while we were down: the reorg window is
   *    seeded with the cursor and its ancestors, so ReorgDetector finds the
   *    common ancestor the same way it does for a live reorg; the orphaned
   *    blocks go to onOrphan, then the winning branch is replayed.
   *
   * Throws CatchUpTooFarError, before replaying anything, when more than
   * `maxBlocks` are pending. Throws NodeBehindCursorError when the node's tip
   * is an ancestor of the cursor (node still syncing); the caller retries.
   */
  async catchUp(cursor: BlockCursor | null, maxBlocks: number): Promise<CatchUpResult> {
    this.reorgDetector = new ReorgDetector(this.reorgDepth);
    this.tipHash = null;

    const tipHash = await this.rpc.getBestBlockHash();
    const tip = await this.rpc.getBlockHeader(tipHash);

    if (cursor === null) {
      this.reorgDetector.addBlock(tip);
      this.tipHash = tipHash;
      return { replayed: 0, orphaned: 0, tipHeight: tip.height };
    }

    const pending = tip.height - cursor.height;
    if (pending > maxBlocks) throw new CatchUpTooFarError(pending, maxBlocks, cursor, tip.height);

    // Seed the window with the cursor block and its ancestors, as deep as a
    // live reorg can reach, so a cursor on an orphaned branch finds its
    // common ancestor with the active chain.
    let header: BlockHeader | null = await this.rpc.getBlockHeader(cursor.hash);
    for (let i = 0; i < this.reorgDepth && header !== null; i++) {
      this.reorgDetector.addBlock(header);
      header = header.previousblockhash === ''
        ? null
        : await this.rpc.getBlockHeader(header.previousblockhash);
    }

    if (pending < 0 && this.reorgDetector.knows(tipHash)) {
      throw new NodeBehindCursorError(cursor, tip.height);
    }

    this.tipHash = cursor.hash;
    return {
      ...(await this.advanceTo(tipHash, Math.max(pending, 0) + this.reorgDepth)),
      tipHeight: tip.height,
    };
  }

  /**
   * Run one poll cycle: fetch the tip, detect changes, emit events.
   * Returns immediately if nothing changed.
   */
  async poll(): Promise<void> {
    const newTipHash = await this.rpc.getBestBlockHash();

    if (this.tipHash === null) {
      // First poll: bootstrap the window but don't emit onBlock for historical blocks.
      const header = await this.rpc.getBlockHeader(newTipHash);
      this.reorgDetector.addBlock(header);
      this.tipHash = newTipHash;
      return;
    }

    await this.advanceTo(newTipHash);
  }

  /** Emit orphan + new-block events to move from this.tipHash to newTipHash. */
  private async advanceTo(
    newTipHash: string,
    maxWalk?: number,
  ): Promise<{ replayed: number; orphaned: number }> {
    const diff = await this.reorgDetector.computeDiff(
      newTipHash,
      (hash) => this.rpc.getBlockHeader(hash),
      this.tipHash!,
      maxWalk,
    );

    if (diff === null) return { replayed: 0, orphaned: 0 };

    // Emit orphan events first (so downstream can deconfirm before re-confirming)
    for (const header of diff.orphaned) {
      await this.handlers.onOrphan(header);
      this.reorgDetector.addBlock(header); // keep in window briefly
    }

    // Emit new block events. A block joins the window only after onBlock
    // succeeds: if the handler throws, the next poll walks back to the last
    // good block and re-emits this one instead of silently skipping it.
    for (const header of diff.added) {
      const block = await this.rpc.getBlock(header.hash);
      await this.handlers.onBlock(block);
      this.reorgDetector.addBlock(header);
    }

    this.tipHash = newTipHash;
    return { replayed: diff.added.length, orphaned: diff.orphaned.length };
  }

  /**
   * Start polling at the given interval.
   * Resolves when stop() is called or onError returns true.
   */
  async start(intervalMs: number): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        const stop = this.handlers.onError?.(err);
        if (stop) {
          this.running = false;
          break;
        }
      }
      if (this.running) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  get currentTip(): string | null {
    return this.tipHash;
  }
}
