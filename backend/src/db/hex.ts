/**
 * Helpers for converting between hex strings and Postgres BYTEA (Buffer).
 * deposit_id is stored as BYTEA (bytes32) in the DB.
 */

import type { Hex } from '@wbob/shared';

export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}

export function bufferToHex(buf: Buffer): Hex {
  return `0x${buf.toString('hex')}` as Hex;
}
