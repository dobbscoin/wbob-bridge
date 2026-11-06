import { describe, it, expect } from 'vitest';
import { detectControllerVersion } from '../../src/gnosis/controller-version.js';

const client = (impl: () => Promise<unknown>) => ({ readContract: impl as never });

describe('detectControllerVersion', () => {
  it('V2 answers remainingMintCapacity()', async () => {
    expect(await detectControllerVersion(client(async () => 123n), '0x' + '1'.repeat(40))).toBe(2);
  });
  it('V1 reverts (no such function)', async () => {
    expect(await detectControllerVersion(client(async () => { throw new Error('execution reverted'); }), '0x' + '1'.repeat(40))).toBe(1);
    expect(await detectControllerVersion(client(async () => { throw new Error('The contract function "remainingMintCapacity" returned no data ("0x").'); }), '0x' + '1'.repeat(40))).toBe(1);
  });
  it('an RPC failure is NOT taken as "V1"', async () => {
    await expect(detectControllerVersion(client(async () => { throw new Error('fetch failed: ECONNREFUSED'); }), '0x' + '1'.repeat(40)))
      .rejects.toThrow(/ECONNREFUSED/);
  });
});
