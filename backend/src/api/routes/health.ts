/**
 * GET /v1/health — bridge solvency and operational status.
 *
 * Returns the most recent solvency snapshot plus a rolled-up status string:
 *   "ok"       — bridge is solvent, no stuck orders
 *   "degraded" — not solvent or orders are stuck (but still running)
 *   "starting" — monitor hasn't completed its first poll yet
 */

import type { FastifyInstance } from 'fastify';
import type { SolvencyMonitor } from '../../monitor/solvency-monitor.js';

export async function healthRoute(
  fastify: FastifyInstance,
  opts: { monitor: SolvencyMonitor },
): Promise<void> {

  fastify.get('/v1/health', async (_request, reply) => {
    const snap = opts.monitor.getLastSnapshot();

    if (!snap) {
      return reply.send({
        status: 'starting',
        solvency: null,
        stuckOrderCount: 0,
        lastChecked: null,
      });
    }

    const isHealthy = snap.isSolvent && snap.stuckOrderCount === 0;
    const status = isHealthy ? 'ok' : 'degraded';

    return reply.send({
      status,
      solvency: {
        wBobSupplySat:         snap.wBobSupplySat.toString(),
        utxoPoolSat:           snap.utxoPoolSat.toString(),
        cumulativeFeesPaidSat: snap.cumulativeFeesPaidSat.toString(),
        pendingPayoutsSat:     snap.pendingPayoutsSat.toString(),
        coverageRatio:         snap.coverageRatio.toFixed(6),
        isSolvent:             snap.isSolvent,
      },
      stuckOrderCount: snap.stuckOrderCount,
      lastChecked:     snap.checkedAt,
    });
  });
}
