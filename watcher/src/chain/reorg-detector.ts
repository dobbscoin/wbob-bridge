/**
 * Reorg detector.
 *
 * Maintains a sliding window of recent block headers (hash + height +
 * previousblockhash) so it can detect when a reorg rolls back the chain.
 *
 * Algorithm:
 *   When a new tip is reported, walk backwards from the new tip until we find
 *   a block we already know (the common ancestor). Everything between our last
 *   known tip and the ancestor was orphaned; the new fork wins.
 *
 * Pure, no I/O — callers supply the RPC fetch function.
 */

import type { BlockHeader } from '../rpc/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReorgResult {
  /** Blocks removed from the canonical chain (orphaned), in height-desc order. */
  orphaned: BlockHeader[];
  /** Blocks added on the new fork, in height-asc order. */
  added: BlockHeader[];
  /** The common ancestor (not orphaned, not added — it stays). */
  commonAncestor: BlockHeader;
}

// ─── ReorgDetector ────────────────────────────────────────────────────────────

export class ReorgDetector {
  /**
   * Map of blockHash → BlockHeader for the current known chain window.
   * Newest blocks at the top; we prune entries below `depth`.
   */
  private readonly window = new Map<string, BlockHeader>();

  /**
   * @param depth  How many blocks to keep in the local window.
   *               Should be >= (finality depth + safety margin).
   *               Default: 200.
   */
  constructor(private readonly depth: number = 200) {}

  /**
   * Import a block into the local window. Call this for every new block seen.
   */
  addBlock(header: BlockHeader): void {
    this.window.set(header.hash, header);
    this._prune(header.height);
  }

  /**
   * Returns true if we already know about this block hash.
   */
  knows(hash: string): boolean {
    return this.window.has(hash);
  }

  /**
   * Given a new chain tip hash (fetched from the node), compute what changed
   * since our last known tip.
   *
   * @param newTipHash   The hash returned by getBestBlockHash()
   * @param fetchHeader  Async function to retrieve a BlockHeader by hash
   * @param oldTipHash   Our previously recorded tip hash
   * @returns null if newTipHash === oldTipHash (nothing changed)
   *          ReorgResult describing what was orphaned and what was added
   */
  async computeDiff(
    newTipHash: string,
    fetchHeader: (hash: string) => Promise<BlockHeader>,
    oldTipHash: string,
  ): Promise<ReorgResult | null> {
    if (newTipHash === oldTipHash) return null;

    // Collect the new fork walking backwards until we hit a known block.
    const added: BlockHeader[] = [];
    let cursor = newTipHash;

    while (!this.window.has(cursor)) {
      const header = await fetchHeader(cursor);
      added.push(header);
      cursor = header.previousblockhash;
      if (cursor === '') {
        // Reached genesis without finding common ancestor — shouldn't happen
        // in practice; bail out to avoid infinite loop.
        throw new Error('ReorgDetector: walked back to genesis without finding common ancestor');
      }
    }

    const commonAncestor = this.window.get(cursor)!;

    // Collect orphaned blocks: everything in our window above the common ancestor height.
    const orphaned: BlockHeader[] = [];
    for (const header of this.window.values()) {
      if (header.height > commonAncestor.height) {
        orphaned.push(header);
      }
    }
    // Sort orphaned height-desc (highest first — callers deconfirm in that order)
    orphaned.sort((a, b) => b.height - a.height);

    // Sort added height-asc (lowest first — callers apply in order)
    added.sort((a, b) => a.height - b.height);

    return { orphaned, added, commonAncestor };
  }

  /** Remove all window entries whose height is more than `depth` below the given tip. */
  private _prune(tipHeight: number): void {
    const cutoff = tipHeight - this.depth;
    for (const [hash, header] of this.window) {
      if (header.height < cutoff) this.window.delete(hash);
    }
  }

  /** For testing: returns window size. */
  get windowSize(): number {
    return this.window.size;
  }
}
