/** Review round 11: the monitor alerts when watchers fall behind (they have no alert channel of their own). */
import { describe, it, expect } from 'vitest';
import { SolvencyMonitor } from '../../src/monitor/solvency-monitor.js';
import type { BackendConfig } from '../../src/config.js';

const config = { gnosisRpcUrl: 'http://192.0.2.1:1', gnosisRpcUrls: ['http://192.0.2.1:1'], wBobAddress: null } as unknown as BackendConfig;
function monitor(rows: { watcher_id: string; block_height: number; updated_at: Date }[], tip: number) {
  const sql = (async () => rows) as unknown;
  const rpc = { call: async () => tip } as unknown;
  return new SolvencyMonitor(sql as never, config, null, rpc as never);
}
const now = new Date();
const w = (id: string, h: number, minAgo = 0) => ({ watcher_id: id, block_height: h, updated_at: new Date(now.getTime() - minAgo * 60_000) });

describe('watcher lag alerts', () => {
  it('quiet when every watcher is current', async () => {
    expect(await monitor([w('a', 1000), w('b', 999), w('c', 1000), w('d', 1000), w('e', 998)], 1000).watcherLagAlerts('t')).toEqual([]);
  });
  it('a watcher far behind is a warning while 3+ are current', async () => {
    const a = await monitor([w('a', 1000), w('b', 900), w('c', 1000), w('d', 1000), w('e', 1000)], 1000).watcherLagAlerts('t');
    expect(a).toHaveLength(1);
    expect(a[0]!.level).toBe('warning');
    expect(a[0]!.type).toBe('WATCHER_LAG');
  });
  it('fewer than 3 current (stale updates count as behind) is critical', async () => {
    const a = await monitor([w('a', 1000), w('b', 900), w('c', 1000, 120), w('d', 800), w('e', 1000)], 1000).watcherLagAlerts('t');
    expect(a[0]!.level).toBe('critical');
    expect(a[0]!.message).toMatch(/will NOT mint/);
  });
});
