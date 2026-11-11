import { describe, it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, type Hex } from 'viem';
import { BurnVerifier, type BurnChainReader } from '../../src/gnosis/burn-verifier.js';
import type { BackendConfig } from '../../src/config.js';

const EV = parseAbiItem('event WithdrawalRequested(uint256 indexed withdrawalId, address indexed sender, uint256 amount, string dobbscoinAddress, uint256 nonce)');
const CTRL = '0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872';
const SENDER = '0x' + '2'.repeat(40);
const ADDR = '1L9YGqctBWaCmn7y8d8CBkTXzXXZ4EAECN';
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const config = { bridgeControllerAddress: CTRL, gnosisConfirmationDepth: 12, gnosisRpcUrl: 'http://x' } as unknown as BackendConfig;

function log(o: { id?: bigint; amount?: bigint; dest?: string; address?: string; sender?: string } = {}) {
  return {
    address: o.address ?? CTRL,
    topics: encodeEventTopics({ abi: [EV], eventName: 'WithdrawalRequested', args: { withdrawalId: o.id ?? 7n, sender: (o.sender ?? SENDER) as Hex } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }, { type: 'uint256' }], [o.amount ?? 500_000n, o.dest ?? ADDR, 0n]),
  };
}
function reader(r: { status?: 'success' | 'reverted'; logs?: ReturnType<typeof log>[]; block?: bigint; tip?: bigint; err?: Error; finalized?: bigint | null } = {}): BurnChainReader {
  return {
    getTransactionReceipt: async () => { if (r.err) throw r.err; return { status: r.status ?? 'success', blockNumber: r.block ?? 100n, logs: r.logs ?? [log()] }; },
    getBlockNumber: async () => r.tip ?? 200n,
    getBlock: async () => ({ number: r.finalized === undefined ? (r.tip ?? 200n) : r.finalized }),
  };
}
const claim = { withdrawalId: '7', burnTxHash: HASH as string | null, senderAddress: SENDER, amountSat: 500_000n, dobbscoinAddress: ADDR };
const v = (r: Parameters<typeof reader>[0] = {}, c = claim) => new BurnVerifier(config, reader(r)).verify(c);

describe('BurnVerifier', () => {
  it('passes a real, deep, matching burn', async () => { expect(await v()).toEqual({ ok: true }); });
  it('refuses a raised amount', async () => { expect(await v({}, { ...claim, amountSat: 900_000n })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a redirected destination', async () => { expect(await v({}, { ...claim, dobbscoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a different sender', async () => { expect(await v({}, { ...claim, senderAddress: '0x' + '3'.repeat(40) })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a log from another contract (fake controller)', async () => { expect(await v({ logs: [log({ address: '0x' + '9'.repeat(40) })] })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a burn tx with a different withdrawalId', async () => { expect(await v({ logs: [log({ id: 8n })] })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a reverted tx', async () => { expect(await v({ status: 'reverted' })).toMatchObject({ ok: false, defer: false }); });
  it('refuses a missing hash', async () => {
    expect(await v({}, { ...claim, burnTxHash: null })).toMatchObject({ ok: false, defer: false });
  });
  const notFound = () => Object.assign(new Error('Transaction receipt with hash "0xab" could not be found.'), { name: 'TransactionReceiptNotFoundError' });
  it('a receipt our node lacks: defers while the node is behind the burn, refuses only after the grace period', async () => {
    const lagging = new BurnVerifier(config, reader({ err: notFound(), tip: 105n }));
    expect(await lagging.verify({ ...claim, burnBlockNumber: 100n })).toMatchObject({ ok: false, defer: true });
    const caughtUp = new BurnVerifier(config, reader({ err: notFound(), tip: 500n }));
    expect(await caughtUp.verify({ ...claim, burnBlockNumber: 100n })).toMatchObject({ ok: false, defer: true });
    caughtUp.notFoundGraceMs = 0;
    expect(await caughtUp.verify({ ...claim, burnBlockNumber: 100n })).toMatchObject({ ok: false, defer: false });
  });
  it('a proxy 404 page or any other error is never "does not exist"', async () => {
    const r = new BurnVerifier(config, reader({ err: new Error('HTTP request failed. Status: 404 Not Found'), tip: 500n }));
    r.notFoundGraceMs = 0;
    expect(await r.verify({ ...claim, burnBlockNumber: 100n })).toMatchObject({ ok: false, defer: true });
  });
  it('a deep but not yet finalized burn defers', async () => {
    expect(await v({ block: 100n, tip: 200n, finalized: 90n })).toMatchObject({ ok: false, defer: true });
    expect(await v({ block: 100n, tip: 200n, finalized: 150n })).toEqual({ ok: true });
  });
  it('defers (does not refuse) when the node is unreachable or the burn is shallow', async () => {
    expect(await v({ err: new Error('fetch failed') })).toMatchObject({ ok: false, defer: true });
    expect(await v({ block: 195n, tip: 200n })).toMatchObject({ ok: false, defer: true });
  });
  it('compares the destination as ingest stored it (sanitized)', async () => {
    const bad = 'a\u0000b';
    expect(await v({ logs: [log({ dest: bad })] }, { ...claim, dobbscoinAddress: 'INVALID:610062' })).toEqual({ ok: true });
  });
});
