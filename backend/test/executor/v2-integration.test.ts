/**
 * BridgeControllerV2 integration on the backend side (2026-11-06).
 * Pure: no DB, no chain. The cross-language check against the real contract
 * (digest, outpointKey, a real executeMint with TS-made signatures) was run
 * on anvil + the live V1; these pin the same values so a drift fails CI.
 */
import { describe, it, expect } from 'vitest';
import { computeCapWindow, availableCapacity, type MintCapChainState } from '../../src/executor/mint-capacity.js';
import { outpointKey, describeRevert } from '../../src/executor/mint-executor.js';
import { parseBridgeControllerVersion, bridgeControllerDomain, MINT_AUTHORIZATION_TYPEHASH } from '@wbob/shared';

const base: MintCapChainState = {
  dailyMintLimit: 250_000_00000000n, currentDayMinted: 0n, currentDayStart: 1_793_232_000n,
  maxSupply: 0n, totalSupply: 0n, blockNumber: 1n, blockTimestamp: 1_793_232_000n + 3600n,
};

describe('capacity with a V2 rolling cap', () => {
  it('V1 (no controller cap): unchanged', () => {
    expect(computeCapWindow(base).remainingTodaySat).toBe(250_000_00000000n);
  });
  it('V2: the smaller of the token day and the controller window wins', () => {
    expect(computeCapWindow({ ...base, controllerRemainingSat: 40_000_00000000n }).remainingTodaySat).toBe(40_000_00000000n);
    expect(computeCapWindow({ ...base, currentDayMinted: 240_000_00000000n, controllerRemainingSat: 40_000_00000000n }).remainingTodaySat)
      .toBe(10_000_00000000n);
  });
  it('after UTC midnight the token resets but the V2 window does not: the window still binds', () => {
    const afterMidnight = { ...base, currentDayMinted: 250_000_00000000n, blockTimestamp: base.currentDayStart + 86_400n + 60n,
                            controllerRemainingSat: 0n };
    const w = computeCapWindow(afterMidnight);
    expect(w.windowStale).toBe(true);           // token side looks fresh...
    expect(w.remainingTodaySat).toBe(0n);       // ...but V2 still has nothing left
    expect(availableCapacity(w, 0n)).toBe(0n);
  });
});

describe('V2 replay key and revert names', () => {
  it('outpointKey matches keccak256(abi.encode(uint256,bytes32,uint32)) computed by cast', () => {
    expect(outpointKey(1_000_001n, '0x00ba16cf912b00c6e863d3304f31ee6bc1c2643f60be65d6c6613ae136b33132', 1))
      .toBe('0x55e0f5a32221bb225d7ae972fbb3f24060ab474bd93c80ec6ad4f0b8ee3e470d');
  });
  it('a non-contract error is not mistaken for a known revert', () => {
    expect(describeRevert(new Error('socket hang up')).name).toBeNull();
  });
});

describe('controller version / EIP-712 domain', () => {
  it('defaults to 1 and accepts only 1 or 2', () => {
    expect(parseBridgeControllerVersion(undefined)).toBe(1);
    expect(parseBridgeControllerVersion('')).toBe(1);
    expect(parseBridgeControllerVersion('2')).toBe(2);
    expect(() => parseBridgeControllerVersion('3')).toThrow(/must be 1 or 2/);
  });
  it('domain version follows the controller; name and chain stay', () => {
    expect(bridgeControllerDomain(1)).toEqual({ name: 'BridgeController', version: '1', chainId: 100 });
    expect(bridgeControllerDomain(2)).toEqual({ name: 'BridgeController', version: '2', chainId: 100 });
  });
  it('typehash constant is the real keccak (was a 63-char placeholder)', () => {
    expect(MINT_AUTHORIZATION_TYPEHASH).toBe('0xe9a8fb1f12f30a50b81623dfdc4d902d18972dd0ed0eaf0b99f74c7d40f8a812');
  });
});
