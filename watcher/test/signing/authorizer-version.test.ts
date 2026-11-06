import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { MintAuthorizer } from '../../src/signing/authorizer.js';
import { bridgeControllerDomain, MINT_AUTHORIZATION_TYPES } from '@wbob/shared';

const PK = ('0x' + '07'.repeat(32)) as Hex;
const CONTROLLER = '0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872' as Hex;
const auth = {
  depositId: ('0x' + '11'.repeat(32)) as Hex, recipient: '0x000000000000000000000000000000000000dEaD' as Hex,
  amount: 1n, sourceChainId: 1_000_001n, sourceTxHash: ('0x' + '22'.repeat(32)) as Hex, sourceVout: 0,
  deadline: 4_000_000_000n, nonce: 0n,
};
const digest = (v: 1 | 2) => hashTypedData({
  domain: { ...bridgeControllerDomain(v), verifyingContract: CONTROLLER },
  types: MINT_AUTHORIZATION_TYPES, primaryType: 'MintAuthorization', message: auth,
});

describe('MintAuthorizer controller version', () => {
  it('default (no version) signs the V1 domain, exactly as before', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER });
    const sig = await a.sign(auth as never);
    expect(await recoverAddress({ hash: digest(1), signature: sig })).toBe(a.address);
  });
  it('version 2 signs the V2 domain, which a V1 verifier would not accept', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER, bridgeControllerVersion: 2 });
    const sig = await a.sign(auth as never);
    expect(await recoverAddress({ hash: digest(2), signature: sig })).toBe(a.address);
    expect(await recoverAddress({ hash: digest(1), signature: sig })).not.toBe(a.address);
  });
});
