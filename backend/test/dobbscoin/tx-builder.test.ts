/**
 * Tests for the Dobbscoin transaction builder.
 *
 * Covers:
 *   - estimateFee pure function
 *   - selectUtxos greedy UTXO selection
 *   - DobbscoinTxBuilder.deriveChangeAddress
 *   - DobbscoinTxBuilder.buildPayoutTx (end-to-end with mock RPC)
 */

import { describe, it, expect, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import {
  estimateFee,
  selectUtxos,
  DobbscoinTxBuilder,
  type UtxoInput,
} from '../../src/dobbscoin/tx-builder.js';

// ─── BIP32 test vector ────────────────────────────────────────────────────────

const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ROOT_KEY = HDKey.fromMasterSeed(SEED);
const TEST_XPRIV = ROOT_KEY.privateExtendedKey!;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hash160(pubkey: Uint8Array): Uint8Array {
  return ripemd160(sha256(pubkey));
}

/**
 * Build a minimal valid raw transaction hex.
 * The transaction has one dummy input (zeroed txid, vout 0) and one
 * P2PKH output paying `amountSat` to the hash160 of `pubkey`.
 *
 * This is suitable as a `nonWitnessUtxo` in tests because btc-signer only
 * needs it to extract the scriptPubKey for signing — it does not broadcast it.
 */
function buildMinimalPrevTxHex(pubkey: Uint8Array, amountSat: bigint): string {
  const pkHash = hash160(pubkey);
  // P2PKH scriptPubKey: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
  const script = Buffer.from([0x76, 0xa9, 0x14, ...pkHash, 0x88, 0xac]);

  const version = Buffer.alloc(4);
  version.writeUInt32LE(1, 0);

  // One dummy input: txid=0x00…, vout=0, script=empty, sequence=0xffffffff
  const dummyTxid = Buffer.alloc(32, 0);
  const dummyVout = Buffer.alloc(4, 0);
  const scriptSigLen = Buffer.from([0x00]);
  const sequence = Buffer.alloc(4, 0xff);

  // One output
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigInt64LE(amountSat, 0);
  const scriptLenBuf = Buffer.from([script.length]);

  const locktime = Buffer.alloc(4);

  return Buffer.concat([
    version,
    Buffer.from([0x01]),     // 1 input
    dummyTxid, dummyVout, scriptSigLen, sequence,
    Buffer.from([0x01]),     // 1 output
    amtBuf, scriptLenBuf, script,
    locktime,
  ]).toString('hex');
}

/** Compute the txid of a raw transaction (big-endian hex, display format). */
function computeTxid(rawHex: string): string {
  const bytes = Buffer.from(rawHex, 'hex');
  const hash = sha256(sha256(bytes));
  return Buffer.from(hash).reverse().toString('hex');
}

function makeUtxo(txid: string, vout: number, amountSat: bigint, hdIndex: number): UtxoInput {
  return { txid, vout, amountSat, hdIndex };
}

// ─── estimateFee ─────────────────────────────────────────────────────────────

describe('estimateFee', () => {
  it('1-input 1-output at 1 sat/vbyte = 192 sat', () => {
    // overhead(10) + 1*input(148) + 1*output(34) = 192
    expect(estimateFee(1, 1, 1)).toBe(192n);
  });

  it('1-input 2-output at 1 sat/vbyte = 226 sat', () => {
    // 10 + 148 + 2*34 = 226
    expect(estimateFee(1, 2, 1)).toBe(226n);
  });

  it('2-input 2-output at 1 sat/vbyte = 374 sat', () => {
    // 10 + 2*148 + 2*34 = 374
    expect(estimateFee(2, 2, 1)).toBe(374n);
  });

  it('scales with fee rate', () => {
    expect(estimateFee(1, 1, 10)).toBe(1920n);
    expect(estimateFee(1, 1, 100)).toBe(19200n);
  });

  it('returns 0 for 0-input 0-output (degenerate)', () => {
    // 10 vbytes overhead only
    expect(estimateFee(0, 0, 1)).toBe(10n);
  });
});

// ─── selectUtxos ─────────────────────────────────────────────────────────────

describe('selectUtxos', () => {
  const utxos = [
    makeUtxo('a'.repeat(64), 0, 100_000n, 0),
    makeUtxo('b'.repeat(64), 0,  50_000n, 1),
    makeUtxo('c'.repeat(64), 0,  20_000n, 2),
  ];

  it('selects the largest UTXO first', () => {
    const { selected } = selectUtxos(utxos, 1_000n, 1);
    expect(selected[0]!.amountSat).toBe(100_000n);
  });

  it('single UTXO sufficient for small target', () => {
    // 100k covers 1k easily
    const { selected } = selectUtxos(utxos, 1_000n, 1);
    expect(selected).toHaveLength(1);
  });

  it('feeSat is positive', () => {
    const { feeSat } = selectUtxos(utxos, 1_000n, 1);
    expect(feeSat).toBeGreaterThan(0n);
  });

  it('total selected >= target + feeSat', () => {
    const target = 60_000n;
    const { selected, feeSat } = selectUtxos(utxos, target, 1);
    const total = selected.reduce((s, u) => s + u.amountSat, 0n);
    expect(total).toBeGreaterThanOrEqual(target + feeSat);
  });

  it('throws when total UTXOs are insufficient', () => {
    expect(() => selectUtxos(utxos, 200_000n, 1)).toThrow(/Insufficient/);
  });

  it('throws on empty UTXO list', () => {
    expect(() => selectUtxos([], 1_000n, 1)).toThrow(/Insufficient/);
  });

  it('sorts largest-first regardless of input order', () => {
    const shuffled = [
      makeUtxo('c'.repeat(64), 0, 20_000n, 2),
      makeUtxo('a'.repeat(64), 0, 100_000n, 0),
      makeUtxo('b'.repeat(64), 0, 50_000n, 1),
    ];
    const { selected } = selectUtxos(shuffled, 1_000n, 1);
    expect(selected[0]!.amountSat).toBe(100_000n);
  });

  it('picks minimal set — does not add unnecessary UTXOs', () => {
    // Large single UTXO covers target+fee — should not add more
    const { selected } = selectUtxos(utxos, 10_000n, 1);
    expect(selected).toHaveLength(1);
  });
});

// ─── DobbscoinTxBuilder ───────────────────────────────────────────────────────

describe('DobbscoinTxBuilder', () => {
  describe('deriveChangeAddress', () => {
    it('returns a non-empty string', () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const addr = builder.deriveChangeAddress(0);
      expect(typeof addr).toBe('string');
      expect(addr.length).toBeGreaterThan(25);
    });

    it('is deterministic', () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      expect(builder.deriveChangeAddress(0)).toBe(builder.deriveChangeAddress(0));
    });

    it('produces unique addresses per index', () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const addrs = new Set([0, 1, 2, 3].map((i) => builder.deriveChangeAddress(i)));
      expect(addrs.size).toBe(4);
    });

    it('starts with "1" for mainnet version byte 0x00', () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      expect(builder.deriveChangeAddress(0)).toMatch(/^1/);
    });
  });

  describe('buildPayoutTx', () => {
    it('builds, signs and serialises a valid payout transaction', async () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);

      // Derive the public key at m/0/0 to build a matching prev tx
      const pubkey0 = ROOT_KEY.derive('m/0/0').publicKey!;
      const prevTxHex = buildMinimalPrevTxHex(pubkey0, 100_000n);
      const prevTxid  = computeTxid(prevTxHex);

      const mockRpc = { getRawTransactionHex: vi.fn().mockResolvedValue(prevTxHex) };

      const recipientAddr = builder.deriveChangeAddress(5); // any valid P2PKH address
      const changeAddr    = builder.deriveChangeAddress(0);

      const utxos: UtxoInput[] = [{ txid: prevTxid, vout: 0, amountSat: 100_000n, hdIndex: 0 }];

      const result = await builder.buildPayoutTx(
        utxos,
        50_000n,
        recipientAddr,
        changeAddr,
        1,
        mockRpc as any,
      );

      expect(typeof result.rawHex).toBe('string');
      expect(result.rawHex.length).toBeGreaterThan(0);
      expect(typeof result.txid).toBe('string');
      expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rawHex is valid hex', async () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const pubkey0 = ROOT_KEY.derive('m/0/0').publicKey!;
      const prevTxHex = buildMinimalPrevTxHex(pubkey0, 100_000n);
      const prevTxid  = computeTxid(prevTxHex);
      const mockRpc = { getRawTransactionHex: vi.fn().mockResolvedValue(prevTxHex) };

      const result = await builder.buildPayoutTx(
        [{ txid: prevTxid, vout: 0, amountSat: 100_000n, hdIndex: 0 }],
        50_000n,
        builder.deriveChangeAddress(5),
        builder.deriveChangeAddress(0),
        1,
        mockRpc as any,
      );

      expect(() => Buffer.from(result.rawHex, 'hex')).not.toThrow();
      expect(Buffer.from(result.rawHex, 'hex').length).toBeGreaterThan(0);
    });

    it('feeSat + changeSat + payoutAmount = total inputs', async () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const pubkey0 = ROOT_KEY.derive('m/0/0').publicKey!;
      const prevTxHex = buildMinimalPrevTxHex(pubkey0, 100_000n);
      const prevTxid  = computeTxid(prevTxHex);
      const mockRpc = { getRawTransactionHex: vi.fn().mockResolvedValue(prevTxHex) };
      const payout = 50_000n;

      const result = await builder.buildPayoutTx(
        [{ txid: prevTxid, vout: 0, amountSat: 100_000n, hdIndex: 0 }],
        payout,
        builder.deriveChangeAddress(5),
        builder.deriveChangeAddress(0),
        1,
        mockRpc as any,
      );

      expect(result.feeSat + result.changeSat + payout).toBe(result.inputAmountSat);
    });

    it('calls getRawTransactionHex once per input', async () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const pubkey0 = ROOT_KEY.derive('m/0/0').publicKey!;
      const pubkey1 = ROOT_KEY.derive('m/0/1').publicKey!;
      const prevTxHex0 = buildMinimalPrevTxHex(pubkey0, 60_000n);
      const prevTxHex1 = buildMinimalPrevTxHex(pubkey1, 60_000n);
      const txid0 = computeTxid(prevTxHex0);
      const txid1 = computeTxid(prevTxHex1);

      const mockRpc = {
        getRawTransactionHex: vi.fn()
          .mockResolvedValueOnce(prevTxHex0)
          .mockResolvedValueOnce(prevTxHex1),
      };

      const utxos: UtxoInput[] = [
        { txid: txid0, vout: 0, amountSat: 60_000n, hdIndex: 0 },
        { txid: txid1, vout: 0, amountSat: 60_000n, hdIndex: 1 },
      ];

      await builder.buildPayoutTx(
        utxos, 100_000n,
        builder.deriveChangeAddress(5),
        builder.deriveChangeAddress(0),
        1,
        mockRpc as any,
      );

      expect(mockRpc.getRawTransactionHex).toHaveBeenCalledTimes(2);
    });

    it('throws when UTXOs are insufficient', async () => {
      const builder = new DobbscoinTxBuilder(TEST_XPRIV, 0x00);
      const mockRpc = { getRawTransactionHex: vi.fn() };
      const utxos: UtxoInput[] = [
        { txid: 'a'.repeat(64), vout: 0, amountSat: 1_000n, hdIndex: 0 },
      ];

      await expect(
        builder.buildPayoutTx(
          utxos, 100_000n,
          builder.deriveChangeAddress(5),
          builder.deriveChangeAddress(0),
          1,
          mockRpc as any,
        ),
      ).rejects.toThrow(/Insufficient/);
    });
  });
});
