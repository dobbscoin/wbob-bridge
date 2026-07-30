/**
 * gnosis-rpc-fallback-v1 — RPC resilience for the self-hosted Gnosis node.
 *
 * Two things are locked here:
 *
 *  1. parseGnosisRpcUrls() — the config parser: GNOSIS_RPC_URLS (comma list,
 *     node first) is preferred; legacy single GNOSIS_RPC_URL is the back-compat
 *     default; order is preserved.
 *
 *  2. The READ/WRITE transport split — the safety property of this pass:
 *       - READ clients (publicClient) use viem fallback() across gnosisRpcUrls,
 *         so chain reads survive the node going down.
 *       - WRITE clients (walletClient: executeMint, gas drip, emergency
 *         pause/unpause) stay PINNED to a single endpoint (gnosisRpcUrl).
 *
 *     The write-pinned assertions are a NEGATIVE INVARIANT: they fail if a
 *     future edit ever wraps a walletClient in fallback(). viem's fallback()
 *     selects a transport per individual JSON-RPC request, so it can split a
 *     nonce read (eth_getTransactionCount) from where prior pending txs were
 *     broadcast — across two endpoints with divergent mempools that means
 *     nonce collision / gaps on the money path. Keep writers single-endpoint.
 *     See questions-still-open.md Q27 for the deferred true-failover design.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { BackendConfig } from '../../src/config.js';
import { parseGnosisRpcUrls } from '../../src/config.js';
import { SolvencyMonitor } from '../../src/monitor/solvency-monitor.js';
import { GnosisEventWatcher } from '../../src/gnosis/event-watcher.js';
import { DripSender } from '../../src/executor/drip-sender.js';
import { MintExecutor } from '../../src/executor/mint-executor.js';
import { BridgeGuard } from '../../src/gnosis/bridge-guard.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

// A valid (throwaway) secp256k1 private key — only needed so privateKeyToAccount
// succeeds in the executor/guard constructors. Never funded, never used.
const DUMMY_KEY = `0x${'1'.repeat(64)}` as `0x${string}`;
const MODULE_ADDR = `0x${'2'.repeat(40)}` as `0x${string}`;
const CONTROLLER_ADDR = `0x${'3'.repeat(40)}` as `0x${string}`;

// Placeholder self-hosted-node URL (TEST-NET-1 doc range) — never dialed;
// these tests only assert transport wiring, not connectivity.
const NODE = 'http://192.0.2.1:8545';
const PUBLIC = 'https://rpc.gnosischain.com';

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    gnosisRpcUrl: NODE,
    gnosisRpcUrls: [NODE, PUBLIC],
    executorPrivateKey: DUMMY_KEY,
    dripEnabled: true,
    dripHotWalletPrivateKey: DUMMY_KEY,
    bridgeExecutorModuleAddress: MODULE_ADDR,
    bridgeControllerAddress: CONTROLLER_ADDR,
    gnosisConfirmationDepth: 12,
    gnosisLogScanChunk: 1000,
    gnosisScanHaltAlertThreshold: 10,
    ...(overrides as object),
  } as unknown as BackendConfig;
}

// Construction does no network I/O, so a stub sql is enough — the constructors
// only build viem clients and (for executors) derive an account.
const fakeSql = (() => {}) as never;

// ─── parseGnosisRpcUrls ──────────────────────────────────────────────────────

describe('parseGnosisRpcUrls', () => {
  const SAVED_URLS = process.env['GNOSIS_RPC_URLS'];
  const SAVED_URL = process.env['GNOSIS_RPC_URL'];

  afterEach(() => {
    // restore so we never leak env into other suites
    if (SAVED_URLS === undefined) delete process.env['GNOSIS_RPC_URLS'];
    else process.env['GNOSIS_RPC_URLS'] = SAVED_URLS;
    if (SAVED_URL === undefined) delete process.env['GNOSIS_RPC_URL'];
    else process.env['GNOSIS_RPC_URL'] = SAVED_URL;
  });

  it('parses GNOSIS_RPC_URLS in order, node first', () => {
    process.env['GNOSIS_RPC_URLS'] = `${NODE},${PUBLIC}`;
    delete process.env['GNOSIS_RPC_URL'];
    expect(parseGnosisRpcUrls()).toEqual([NODE, PUBLIC]);
  });

  it('trims whitespace and drops empty segments', () => {
    process.env['GNOSIS_RPC_URLS'] = `  ${NODE} , , ${PUBLIC} ,`;
    expect(parseGnosisRpcUrls()).toEqual([NODE, PUBLIC]);
  });

  it('accepts a single-entry GNOSIS_RPC_URLS', () => {
    process.env['GNOSIS_RPC_URLS'] = NODE;
    expect(parseGnosisRpcUrls()).toEqual([NODE]);
  });

  it('falls back to legacy GNOSIS_RPC_URL when GNOSIS_RPC_URLS is unset', () => {
    delete process.env['GNOSIS_RPC_URLS'];
    process.env['GNOSIS_RPC_URL'] = NODE;
    expect(parseGnosisRpcUrls()).toEqual([NODE]);
  });

  it('throws when GNOSIS_RPC_URLS is present but has no usable URLs', () => {
    process.env['GNOSIS_RPC_URLS'] = ' , , ';
    expect(() => parseGnosisRpcUrls()).toThrow(/no usable URLs/);
  });

  it('throws when neither var is set', () => {
    delete process.env['GNOSIS_RPC_URLS'];
    delete process.env['GNOSIS_RPC_URL'];
    expect(() => parseGnosisRpcUrls()).toThrow(/GNOSIS_RPC_URL/);
  });
});

// ─── read/write transport split ──────────────────────────────────────────────

// Reach into the (private at compile time, plain at runtime) client fields.
function transportType(instance: object, field: 'publicClient' | 'walletClient'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (instance as any)[field].transport.type;
}
function transportCount(instance: object, field: 'publicClient' | 'walletClient'): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (instance as any)[field].transport.transports.length;
}

describe('READ clients use fallback() across the RPC list', () => {
  const cfg = makeConfig();

  it('SolvencyMonitor.publicClient is a fallback over all gnosisRpcUrls', () => {
    const m = new SolvencyMonitor(fakeSql, cfg);
    expect(transportType(m, 'publicClient')).toBe('fallback');
    expect(transportCount(m, 'publicClient')).toBe(cfg.gnosisRpcUrls.length);
  });

  it('GnosisEventWatcher.publicClient is a fallback', () => {
    const w = new GnosisEventWatcher(fakeSql, cfg);
    expect(transportType(w, 'publicClient')).toBe('fallback');
  });

  it('DripSender.publicClient is a fallback', () => {
    const d = new DripSender(fakeSql, cfg);
    expect(transportType(d, 'publicClient')).toBe('fallback');
  });

  it('MintExecutor.publicClient is a fallback', () => {
    const me = new MintExecutor(fakeSql, cfg);
    expect(transportType(me, 'publicClient')).toBe('fallback');
  });

  it('BridgeGuard.publicClient is a fallback', () => {
    const g = new BridgeGuard(cfg);
    expect(transportType(g, 'publicClient')).toBe('fallback');
  });
});

describe('WRITE clients stay pinned to a single endpoint (negative invariant)', () => {
  const cfg = makeConfig();

  // If any of these flips to 'fallback', someone wired the signing path through
  // viem fallback() — the exact nonce-splitting hazard this pass avoids. Do NOT
  // "fix" the test; fix the client (or land Q27's explicit-nonce failover).

  it('MintExecutor.walletClient (executeMint) is NOT fallback', () => {
    const me = new MintExecutor(fakeSql, cfg);
    expect(transportType(me, 'walletClient')).toBe('http');
    expect(transportType(me, 'walletClient')).not.toBe('fallback');
  });

  it('DripSender.walletClient (gas drip) is NOT fallback', () => {
    const d = new DripSender(fakeSql, cfg);
    expect(transportType(d, 'walletClient')).toBe('http');
    expect(transportType(d, 'walletClient')).not.toBe('fallback');
  });

  it('BridgeGuard.walletClient (emergency pause/unpause) is NOT fallback', () => {
    const g = new BridgeGuard(cfg);
    expect(transportType(g, 'walletClient')).toBe('http');
    expect(transportType(g, 'walletClient')).not.toBe('fallback');
  });
});
