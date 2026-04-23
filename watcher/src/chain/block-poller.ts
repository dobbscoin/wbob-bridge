/**
 * Block poller — tracks the chain tip and emits new / orphaned blocks.
 *
 * Delegates reorg detection to ReorgDetector.
 * Emits events by calling the provided callback handlers.
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

// ─── BlockPoller ─────────────────────────────────────────────────────────────

export class BlockPoller {
  private tipHash: string | null = null;
  private readonly reorgDetector: ReorgDetector;
  private running = false;

  constructor(
    private readonly rpc: DobbscoinRpcClient,
    private readonly handlers: BlockPollerHandlers,
    /** How deep a reorg window to maintain. */
    reorgDepth = 200,
  ) {
    this.reorgDetector = new ReorgDetector(reorgDepth);
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

    if (newTipHash === this.tipHash) return;

    const diff = await this.reorgDetector.computeDiff(
      newTipHash,
      (hash) => this.rpc.getBlockHeader(hash),
      this.tipHash,
    );

    if (diff === null) return;

    // Emit orphan events first (so downstream can deconfirm before re-confirming)
    for (const header of diff.orphaned) {
      await this.handlers.onOrphan(header);
      this.reorgDetector.addBlock(header); // keep in window briefly
    }

    // Emit new block events
    for (const header of diff.added) {
      const block = await this.rpc.getBlock(header.hash);
      this.reorgDetector.addBlock(header);
      await this.handlers.onBlock(block);
    }

    this.tipHash = newTipHash;
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
