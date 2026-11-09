/**
 * Review round 7 #4: a V2 watcher takes its cutover floor from the export's
 * allow file (minDepositHeight), refuses to start without it, and refuses a
 * V2_MIN_DEPOSIT_HEIGHT env that disagrees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const BASE: Record<string, string> = {
  DOBBSCOIN_RPC_URL: 'http://127.0.0.1:1', DOBBSCOIN_RPC_USER: 'u', DOBBSCOIN_RPC_PASS: 'p',
  DATABASE_URL: 'postgres://x', WATCHER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  BRIDGE_CONTROLLER_ADDRESS: `0x${'3'.repeat(40)}`, HD_WALLET_XPUB: 'xpub-test',
};
const TX = 'ab'.repeat(32);
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; for (const [k, v] of Object.entries(BASE)) process.env[k] = v;
  delete process.env['V2_PRE_CUTOVER_ALLOW']; delete process.env['V2_MIN_DEPOSIT_HEIGHT']; delete process.env['BRIDGE_CONTROLLER_VERSION']; });
afterEach(() => { process.env = saved; });

function allowFile(body: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'wbob-allow-')), 'allow.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe('watcher V2 cutover floor config', () => {
  it('V1 mode needs nothing', () => {
    expect(loadConfig().v2MinDepositHeight).toBeNull();
  });
  it('V2 refuses to start without the allow file', () => {
    process.env['BRIDGE_CONTROLLER_VERSION'] = '2';
    expect(() => loadConfig()).toThrow(/V2_PRE_CUTOVER_ALLOW/);
  });
  it('V2 takes the floor and the outpoints from the allow file', () => {
    process.env['BRIDGE_CONTROLLER_VERSION'] = '2';
    process.env['V2_PRE_CUTOVER_ALLOW'] = allowFile({ minDepositHeight: 1_950_000, outpoints: [`${TX.toUpperCase()}:1`] });
    const c = loadConfig();
    expect(c.v2MinDepositHeight).toBe(1_950_000);
    expect(c.v2PreCutoverAllowed.has(`${TX}:1`)).toBe(true);
  });
  it('a V2_MIN_DEPOSIT_HEIGHT that disagrees with the file is refused', () => {
    process.env['BRIDGE_CONTROLLER_VERSION'] = '2';
    process.env['V2_PRE_CUTOVER_ALLOW'] = allowFile({ minDepositHeight: 1_950_000, outpoints: [] });
    process.env['V2_MIN_DEPOSIT_HEIGHT'] = '1960000';
    expect(() => loadConfig()).toThrow(/disagrees/);
  });
  it('a malformed outpoint or height is refused', () => {
    process.env['BRIDGE_CONTROLLER_VERSION'] = '2';
    process.env['V2_PRE_CUTOVER_ALLOW'] = allowFile({ minDepositHeight: 1_950_000, outpoints: ['nope'] });
    expect(() => loadConfig()).toThrow(/bad outpoint/);
    process.env['V2_PRE_CUTOVER_ALLOW'] = allowFile({ minDepositHeight: -3, outpoints: [] });
    expect(() => loadConfig()).toThrow(/minDepositHeight/);
  });

  // review round 8 #6
  it('V2 with only V2_MIN_DEPOSIT_HEIGHT (no allow file) refuses to start', () => {
    process.env['BRIDGE_CONTROLLER_VERSION'] = '2';
    process.env['V2_MIN_DEPOSIT_HEIGHT'] = '1950000';
    expect(() => loadConfig()).toThrow(/V2_PRE_CUTOVER_ALLOW/);
  });
  it('a zero or negative V2_MIN_DEPOSIT_HEIGHT is refused', () => {
    process.env['V2_MIN_DEPOSIT_HEIGHT'] = '0';
    expect(() => loadConfig()).toThrow(/must be > 0/);
    process.env['V2_MIN_DEPOSIT_HEIGHT'] = '-5';
    expect(() => loadConfig()).toThrow(/must be > 0/);
  });
});
