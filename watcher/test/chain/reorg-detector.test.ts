/**
 * ReorgDetector unit tests.
 *
 * No I/O — the fetchHeader callback is a pure in-memory function.
 */

import { describe, it, expect } from 'vitest';
import { ReorgDetector } from '../../src/chain/reorg-detector.js';
import type { BlockHeader } from '../../src/rpc/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function header(height: number, hash: string, prev: string): BlockHeader {
  return { height, hash, previousblockhash: prev };
}

/** Build an in-memory chain of `n` blocks starting at genesis. */
function buildChain(n: number, prefix = 'block'): BlockHeader[] {
  const chain: BlockHeader[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? '' : chain[i - 1]!.hash;
    chain.push(header(i, `${prefix}-${i}`, prev));
  }
  return chain;
}

/** Fetch function that looks up headers from a Map. */
function makeFetch(headers: BlockHeader[]): (hash: string) => Promise<BlockHeader> {
  const map = new Map(headers.map((h) => [h.hash, h]));
  return async (hash: string) => {
    const h = map.get(hash);
    if (!h) throw new Error(`Unknown hash: ${hash}`);
    return h;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReorgDetector', () => {
  describe('addBlock / knows', () => {
    it('knows a block after addBlock', () => {
      const d = new ReorgDetector();
      const h = header(1, 'abc', '');
      d.addBlock(h);
      expect(d.knows('abc')).toBe(true);
    });

    it('does not know an unadded block', () => {
      const d = new ReorgDetector();
      expect(d.knows('xyz')).toBe(false);
    });

    it('prunes entries below depth', () => {
      const d = new ReorgDetector(10);
      const chain = buildChain(15);
      for (const h of chain) d.addBlock(h);
      // tip is block-14, depth=10 → prune below height 4
      expect(d.knows('block-0')).toBe(false);
      expect(d.knows('block-3')).toBe(false);
      expect(d.knows('block-4')).toBe(true);  // cutoff is tipHeight - depth = 14 - 10 = 4
      expect(d.knows('block-14')).toBe(true);
    });
  });

  describe('computeDiff', () => {
    it('returns null when newTipHash === oldTipHash', async () => {
      const d = new ReorgDetector();
      const chain = buildChain(5);
      for (const h of chain) d.addBlock(h);
      const tip = chain[4]!;

      const result = await d.computeDiff(tip.hash, makeFetch(chain), tip.hash);
      expect(result).toBeNull();
    });

    it('returns no orphans and 1 added for a simple new block', async () => {
      const d = new ReorgDetector();
      const chain = buildChain(5);
      for (const h of chain.slice(0, 4)) d.addBlock(h); // add blocks 0-3

      const oldTip = chain[3]!;
      const newTip = chain[4]!;

      const result = await d.computeDiff(newTip.hash, makeFetch(chain), oldTip.hash);

      expect(result).not.toBeNull();
      expect(result!.orphaned).toHaveLength(0);
      expect(result!.added).toHaveLength(1);
      expect(result!.added[0]!.hash).toBe(newTip.hash);
      expect(result!.commonAncestor.hash).toBe(oldTip.hash);
    });

    it('returns 2 added for 2 new blocks in a row', async () => {
      const d = new ReorgDetector();
      const chain = buildChain(6);
      for (const h of chain.slice(0, 4)) d.addBlock(h);

      const result = await d.computeDiff(
        chain[5]!.hash,
        makeFetch(chain),
        chain[3]!.hash,
      );

      expect(result!.added).toHaveLength(2);
      expect(result!.added.map((h) => h.hash)).toEqual([chain[4]!.hash, chain[5]!.hash]);
    });

    it('detects a 1-block reorg (fork at height N-1)', async () => {
      // canonical:  ...→ A(4) → B(5)
      // fork:       ...→ A(4) → C(5)
      const common = buildChain(5); // blocks 0–4
      for (const h of common) {
        // block
      }
      const a4 = common[4]!;

      // B: block 5 on canonical chain
      const blockB = header(5, 'block-B', a4.hash);
      // C: block 5 on fork
      const blockC = header(5, 'block-C', a4.hash);

      // Watcher knows common + B
      const d = new ReorgDetector();
      for (const h of common) d.addBlock(h);
      d.addBlock(blockB);

      // Reorg: new tip is C
      const allBlocks = [...common, blockB, blockC];
      const result = await d.computeDiff(blockC.hash, makeFetch(allBlocks), blockB.hash);

      expect(result).not.toBeNull();
      expect(result!.orphaned).toHaveLength(1);
      expect(result!.orphaned[0]!.hash).toBe('block-B');
      expect(result!.added).toHaveLength(1);
      expect(result!.added[0]!.hash).toBe('block-C');
      expect(result!.commonAncestor.hash).toBe(a4.hash);
    });

    it('detects a 2-block deep reorg', async () => {
      // canonical:  ...→ A(3) → B(4) → C(5)
      // fork:       ...→ A(3) → D(4) → E(5)
      const base = buildChain(4); // blocks 0–3
      const a3 = base[3]!;

      const blockB = header(4, 'block-B', a3.hash);
      const blockC = header(5, 'block-C', blockB.hash);
      const blockD = header(4, 'block-D', a3.hash);
      const blockE = header(5, 'block-E', blockD.hash);

      const d = new ReorgDetector();
      for (const h of base) d.addBlock(h);
      d.addBlock(blockB);
      d.addBlock(blockC);

      const all = [...base, blockB, blockC, blockD, blockE];
      const result = await d.computeDiff(blockE.hash, makeFetch(all), blockC.hash);

      expect(result!.orphaned.map((h) => h.hash).sort()).toEqual(['block-B', 'block-C'].sort());
      expect(result!.added.map((h) => h.hash)).toEqual(['block-D', 'block-E']);
      expect(result!.commonAncestor.hash).toBe(a3.hash);
    });

    it('added blocks are sorted height-asc', async () => {
      const base = buildChain(3);
      const a2 = base[2]!;
      const b3 = header(3, 'b3', a2.hash);
      const b4 = header(4, 'b4', b3.hash);
      const b5 = header(5, 'b5', b4.hash);

      const d = new ReorgDetector();
      for (const h of base) d.addBlock(h);

      const all = [...base, b3, b4, b5];
      const result = await d.computeDiff(b5.hash, makeFetch(all), a2.hash);

      expect(result!.added.map((h) => h.height)).toEqual([3, 4, 5]);
    });

    it('orphaned blocks are sorted height-desc', async () => {
      const base = buildChain(3);
      const a2 = base[2]!;
      const old3 = header(3, 'old3', a2.hash);
      const old4 = header(4, 'old4', old3.hash);
      const new3 = header(3, 'new3', a2.hash);
      const new4 = header(4, 'new4', new3.hash);

      const d = new ReorgDetector();
      for (const h of base) d.addBlock(h);
      d.addBlock(old3);
      d.addBlock(old4);

      const all = [...base, old3, old4, new3, new4];
      const result = await d.computeDiff(new4.hash, makeFetch(all), old4.hash);

      expect(result!.orphaned.map((h) => h.height)).toEqual([4, 3]);
    });
  });
});
