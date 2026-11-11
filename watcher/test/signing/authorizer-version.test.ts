import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { MintAuthorizer } from '../../src/signing/authorizer.js';
import { bridgeControllerDomain, mintAuthorizationTypes } from '@wbob/shared';

const PK = ('0x' + '07'.repeat(32)) as Hex;
const CONTROLLER = '0x20a9A6D5FB3615a79603a6Ed74A3d26FB11aB872' as Hex;
const base = {
  depositId: ('0x' + '11'.repeat(32)) as Hex, recipient: '0x000000000000000000000000000000000000dEaD' as Hex,
  amount: 1n, sourceChainId: 1_000_001n, sourceTxHash: ('0x' + '22'.repeat(32)) as Hex, sourceVout: 0,
  deadline: 4_000_000_000n, nonce: 0n,
};
const digest = (v: 1 | 2, message: object) => hashTypedData({
  domain: { ...bridgeControllerDomain(v), verifyingContract: CONTROLLER },
  types: mintAuthorizationTypes(v), primaryType: 'MintAuthorization', message: message as never,
});

describe('MintAuthorizer controller version', () => {
  it('default (no version) signs the V1 struct + domain, exactly as before', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER });
    const sig = await a.sign(base as never);
    expect(await recoverAddress({ hash: digest(1, base), signature: sig })).toBe(a.address);
  });

  it('V1 ignores sourceValue entirely (its struct has no such field)', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER });
    const withValue = await a.sign({ ...base, sourceValue: 5n } as never);
    const without = await a.sign(base as never);
    expect(withValue).toBe(without);
  });

  it('version 2 signs the V2 struct (with sourceValue) and domain; a V1 verifier would not accept it', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER, bridgeControllerVersion: 2 });
    const msg = { ...base, sourceValue: 5n };
    const sig = await a.sign(msg as never);
    expect(await recoverAddress({ hash: digest(2, msg), signature: sig })).toBe(a.address);
    expect(await recoverAddress({ hash: digest(1, base), signature: sig })).not.toBe(a.address);
  });

  it('version 2 refuses to sign without sourceValue', async () => {
    const a = new MintAuthorizer({ privateKey: PK, bridgeControllerAddress: CONTROLLER, bridgeControllerVersion: 2 });
    await expect(a.sign(base as never)).rejects.toThrow(/needs sourceValue/);
  });
});
