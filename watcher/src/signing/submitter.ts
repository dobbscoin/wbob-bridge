/**
 * Signature submitter.
 *
 * Atomically appends this watcher's EIP-712 signature to the mint_requests row.
 * Uses SELECT FOR UPDATE so concurrent watchers can't double-append the same signer.
 *
 * deposit_id is stored as BYTEA in Postgres; we convert from/to Hex strings here.
 */

import type { Sql, JSONValue } from 'postgres';
import type { Address, Hex } from '@wbob/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignatureEntry {
  signer: Address;
  sig: Hex;
}

export interface SubmitResult {
  appended: boolean;
  totalSignatures: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class MintRequestNotFoundError extends Error {
  constructor(public readonly depositId: string) {
    super(`mint_requests row not found for depositId: ${depositId}`);
    this.name = 'MintRequestNotFoundError';
  }
}

// ─── BYTEA helper ────────────────────────────────────────────────────────────

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}

// ─── Submitter ────────────────────────────────────────────────────────────────

export class SignatureSubmitter {
  constructor(private readonly sql: Sql) {}

  async submitSignature(
    depositId: Hex,
    signer: Address,
    sig: Hex,
  ): Promise<SubmitResult> {
    type Row = { signatures: SignatureEntry[] };

    const depositIdBuf = hexToBuffer(depositId);

    const rows = await this.sql<Row[]>`
      SELECT signatures
      FROM mint_requests
      WHERE deposit_id = ${depositIdBuf}
      FOR UPDATE
    `;

    if (rows.length === 0) throw new MintRequestNotFoundError(depositId);

    const current: SignatureEntry[] = rows[0]!.signatures ?? [];

    const alreadyPresent = current.some(
      (e) => e.signer.toLowerCase() === signer.toLowerCase(),
    );

    if (alreadyPresent) return { appended: false, totalSignatures: current.length };

    const updated = [...current, { signer, sig }];

    await this.sql`
      UPDATE mint_requests
      SET signatures      = ${this.sql.json(updated as unknown as JSONValue)},
          signature_count = ${updated.length},
          updated_at      = now()
      WHERE deposit_id = ${depositIdBuf}
    `;

    return { appended: true, totalSignatures: updated.length };
  }

  async getSignatures(depositId: Hex): Promise<SignatureEntry[]> {
    type Row = { signatures: SignatureEntry[] };
    const rows = await this.sql<Row[]>`
      SELECT signatures
      FROM mint_requests
      WHERE deposit_id = ${hexToBuffer(depositId)}
    `;
    if (rows.length === 0) return [];
    return rows[0]!.signatures ?? [];
  }
}

export function createSubmitter(sql: Sql): SignatureSubmitter {
  return new SignatureSubmitter(sql);
}
