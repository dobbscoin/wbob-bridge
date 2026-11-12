/**
 * Signature submitter.
 *
 * Atomically appends this watcher's EIP-712 signature to the mint_requests row.
 * SELECT FOR UPDATE inside one transaction, so concurrent watchers neither
 * double-append the same signer nor overwrite each other's signatures.
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

    // One transaction, so the FOR UPDATE row lock holds across the read, the
    // append and the write. Outside a transaction the lock ends with the SELECT
    // and two watchers can each append to the same old list, losing one signature.
    return this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
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

      await tx`
        UPDATE mint_requests
        SET signatures      = ${tx.json(updated as unknown as JSONValue)},
            signature_count = ${updated.length},
            updated_at      = now()
        WHERE deposit_id = ${depositIdBuf}
      `;

      return { appended: true, totalSignatures: updated.length };
    }) as Promise<SubmitResult>;
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
