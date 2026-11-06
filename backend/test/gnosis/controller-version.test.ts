import { describe, it, expect } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, parseAbi } from 'viem';
import { detectControllerVersion } from '../../src/gnosis/controller-version.js';

const ADDR = ('0x' + '1'.repeat(40)) as `0x${string}`;
const abi = parseAbi(['function remainingMintCapacity() view returns (uint256)']);
const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi, functionName: 'remainingMintCapacity', contractAddress: ADDR });
const client = (impl: () => Promise<unknown>) => ({ readContract: impl as never });

describe('detectControllerVersion (real viem error shapes)', () => {
  it('V2 answers remainingMintCapacity()', async () => {
    expect(await detectControllerVersion(client(async () => 123n), ADDR)).toBe(2);
  });
  it('a contract revert means V1', async () => {
    const e = wrap(new ContractFunctionRevertedError({ abi, functionName: 'remainingMintCapacity', message: 'execution reverted' }));
    expect(await detectControllerVersion(client(async () => { throw e; }), ADDR)).toBe(1);
  });
  it('no return data (no such function) means V1', async () => {
    const e = wrap(new ContractFunctionZeroDataError({ functionName: 'remainingMintCapacity' }));
    expect(await detectControllerVersion(client(async () => { throw e; }), ADDR)).toBe(1);
  });
  it('an HTTP failure wrapped in ContractFunctionExecutionError is NOT taken as V1', async () => {
    const e = wrap(new HttpRequestError({ url: 'http://node', status: 502, body: {} }));
    await expect(detectControllerVersion(client(async () => { throw e; }), ADDR)).rejects.toBe(e);
  });
});
