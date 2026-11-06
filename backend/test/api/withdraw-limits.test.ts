import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { withdrawLimitsRoute } from '../../src/api/routes/withdraw-limits.js';

describe('GET /v1/withdraw-limits', () => {
  it('serves the configured payout minimum as a string', async () => {
    const app = Fastify();
    await app.register(withdrawLimitsRoute, { config: { payoutMinSat: 100_000n } });
    const r = await app.inject({ method: 'GET', url: '/v1/withdraw-limits' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ payoutMinSat: '100000' });
    await app.close();
  });
});
