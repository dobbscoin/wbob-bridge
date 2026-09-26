/**
 * BlockPoller unit tests: startup catch-up from a persisted cursor.
 *
 * No I/O. FakeNode is an in-memory chain that answers the three RPC calls the
 * poller makes (getbestblockhash, getblock as header, getblock as full block).
 */

import { describe, it, expect } from 'vitest';
import {
  BlockPoller,
  CatchUpTooFarError,
  NodeBehindCursorError,
} from '../../src/chain/block-poller.js';
import type { DobbscoinRpcClient } from '../../src/rpc/client.js';
import type { BlockHeader, RpcBlock } from '../../src/rpc/types.js';

// ─── Fake node ───────────────────────────────────────────────────────────────

class FakeNode {
  /** Every block the node has ever seen, including stale branches. */
  readonly blocks = new Map<string, BlockHeader>();
  tip = '';
  calls = 0;

  /** Extend from `parent` (a hash, or '' for genesis) with `n` blocks named `${prefix}-${height}`. */
  extend(parent: string, n: number, prefix = 'main'): string {
    let prev = parent;
    let height = parent === '' ? -1 : this.blocks.get(parent)!.height;
    for (let i = 0; i < n; i++) {
      height++;
      const hash = `${prefix}-${height}`;
      this.blocks.set(hash, { hash, height, previousblockhash: prev });
      prev = hash;
    }
    this.tip = prev;
    return prev;
  }

  header(hash: string): BlockHeader {
    const h = this.blocks.get(hash);
    if (!h) throw new Error(`unknown block ${hash}`);
    return h;
  }

  rpc(): DobbscoinRpcClient {
    return {
      getBestBlockHash: async () => { this.calls++; return this.tip; },
      getBlockHeader:   async (hash: string) => { this.calls++; return this.header(hash); },
      getBlock:         async (hash: string): Promise<RpcBlock> => {
        this.calls++;
        const h = this.header(hash);
        return { hash: h.hash, height: h.height, confirmations: 1, previousblockhash: h.previousblockhash, tx: [] };
      },
    } as unknown as DobbscoinRpcClient;
  }
}

function recorder(opts: { failOnce?: string } = {}) {
  const events: string[] = [];
  let failed = false;
  return {
    events,
    handlers: {
      onBlock: async (b: RpcBlock) => {
        if (b.hash === opts.failOnce && !failed) { failed = true; throw new Error('handler failed'); }
        events.push(`block ${b.hash}`);
      },
      onOrphan: async (h: BlockHeader) => { events.push(`orphan ${h.hash}`); },
    },
  };
}

const cursorAt = (node: FakeNode, hash: string) => ({ hash, height: node.header(hash).height });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BlockPoller.catchUp', () => {
  it('replays every block after the cursor, in height order, then polls normally', async () => {
    const node = new FakeNode();
    node.extend('', 11); // main-0 .. main-10
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const r = await poller.catchUp(cursorAt(node, 'main-5'), 2000);

    expect(rec.events).toEqual(['block main-6', 'block main-7', 'block main-8', 'block main-9', 'block main-10']);
    expect(r).toEqual({ replayed: 5, orphaned: 0, tipHeight: 10 });
    expect(poller.currentTip).toBe('main-10');

    node.extend('main-10', 1);
    await poller.poll();
    expect(rec.events.slice(5)).toEqual(['block main-11']);
  });

  it('replays nothing when the cursor is the tip', async () => {
    const node = new FakeNode();
    node.extend('', 5);
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const r = await poller.catchUp(cursorAt(node, 'main-4'), 2000);
    expect(rec.events).toEqual([]);
    expect(r.replayed).toBe(0);
  });

  it('walks back from a cursor whose block was orphaned while the watcher was down', async () => {
    const node = new FakeNode();
    node.extend('', 7);                    // main-0 .. main-6
    node.extend('main-6', 2, 'stale');     // stale-7, stale-8  (watcher processed these, then died)
    node.extend('main-6', 4, 'main');      // main-7 .. main-10 wins the reorg
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const r = await poller.catchUp(cursorAt(node, 'stale-8'), 2000);

    expect(rec.events).toEqual([
      'orphan stale-8', 'orphan stale-7',
      'block main-7', 'block main-8', 'block main-9', 'block main-10',
    ]);
    expect(r).toEqual({ replayed: 4, orphaned: 2, tipHeight: 10 });
  });

  it('handles an orphaned cursor above a shorter winning chain', async () => {
    const node = new FakeNode();
    node.extend('', 5);                    // main-0 .. main-4
    node.extend('main-4', 3, 'stale');     // stale-5 .. stale-7
    node.extend('main-4', 1, 'main');      // main-5 is the tip, below the cursor height
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    await poller.catchUp(cursorAt(node, 'stale-7'), 2000);
    expect(rec.events).toEqual(['orphan stale-7', 'orphan stale-6', 'orphan stale-5', 'block main-5']);
  });

  it('with no cursor, starts at the tip and replays nothing (first deploy)', async () => {
    const node = new FakeNode();
    node.extend('', 50);
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const r = await poller.catchUp(null, 2000);
    expect(rec.events).toEqual([]);
    expect(r).toEqual({ replayed: 0, orphaned: 0, tipHeight: 49 });

    node.extend('main-49', 1);
    await poller.poll();
    expect(rec.events).toEqual(['block main-50']);
  });

  it('refuses, before replaying or walking anything, when more blocks are pending than the cap', async () => {
    const node = new FakeNode();
    node.extend('', 2601); // tip height 2600
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const err = await poller.catchUp(cursorAt(node, 'main-100'), 2000).catch((e) => e);
    expect(err).toBeInstanceOf(CatchUpTooFarError);
    expect(err.pending).toBe(2500);
    expect(err.message).toContain('2500 blocks are pending');
    expect(rec.events).toEqual([]);
    expect(node.calls).toBe(2); // tip hash + tip header, nothing else
  });

  it('replays exactly up to the cap', async () => {
    const node = new FakeNode();
    node.extend('', 2101);
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    const r = await poller.catchUp(cursorAt(node, 'main-100'), 2000);
    expect(r.replayed).toBe(2000);
    expect(rec.events[0]).toBe('block main-101');
    expect(rec.events.at(-1)).toBe('block main-2100');
  });

  it('waits (throws NodeBehindCursorError) when the node is still syncing below the cursor', async () => {
    const node = new FakeNode();
    node.extend('', 11);
    node.tip = 'main-7'; // node restarted and has only reloaded up to 7
    const rec = recorder();
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    await expect(poller.catchUp(cursorAt(node, 'main-10'), 2000)).rejects.toBeInstanceOf(NodeBehindCursorError);
    expect(rec.events).toEqual([]); // in particular: no bogus orphan events for 8..10

    node.tip = 'main-10';
    await poller.catchUp(cursorAt(node, 'main-10'), 2000);
    expect(rec.events).toEqual([]);
  });

  it('retries after a failed catch-up from the cursor it is given', async () => {
    const node = new FakeNode();
    node.extend('', 11);
    const rec = recorder({ failOnce: 'main-8' });
    const poller = new BlockPoller(node.rpc(), rec.handlers);

    await expect(poller.catchUp(cursorAt(node, 'main-5'), 2000)).rejects.toThrow('handler failed');
    // the caller persisted main-7 as done; it re-reads that and retries
    await poller.catchUp(cursorAt(node, 'main-7'), 2000);
    expect(rec.events).toEqual(['block main-6', 'block main-7', 'block main-8', 'block main-9', 'block main-10']);
  });
});

describe('BlockPoller.poll (steady state)', () => {
  it('re-emits a block whose handler threw, instead of skipping it', async () => {
    const node = new FakeNode();
    node.extend('', 3);
    const rec = recorder({ failOnce: 'main-4' });
    const poller = new BlockPoller(node.rpc(), rec.handlers);
    await poller.poll(); // bootstrap at main-2

    node.extend('main-2', 3); // main-3 .. main-5
    await expect(poller.poll()).rejects.toThrow('handler failed');
    await poller.poll();

    expect(rec.events).toEqual(['block main-3', 'block main-4', 'block main-5']);
  });
});
