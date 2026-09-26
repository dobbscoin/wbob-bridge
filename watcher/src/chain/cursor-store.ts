/**
 * Persisted block cursor: the last block this watcher instance finished.
 * See backend/migrations/011_watcher_cursor.sql.
 */

import type { Sql } from 'postgres';
import type { BlockCursor } from './block-poller.js';

export async function loadCursor(sql: Sql<any>, watcherId: string): Promise<BlockCursor | null> {
  let rows: { block_height: number; block_hash: string }[];
  try {
    rows = await sql<{ block_height: number; block_hash: string }[]>`
      SELECT block_height, block_hash FROM watcher_cursors WHERE watcher_id = ${watcherId}
    `;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      throw new Error('table watcher_cursors does not exist: apply migration 011 (backend: npm run migrate) before starting this watcher');
    }
    throw err;
  }
  const row = rows[0];
  return row === undefined ? null : { height: row.block_height, hash: row.block_hash };
}

export async function saveCursor(sql: Sql<any>, watcherId: string, cursor: BlockCursor): Promise<void> {
  await sql`
    INSERT INTO watcher_cursors (watcher_id, block_height, block_hash)
    VALUES (${watcherId}, ${cursor.height}, ${cursor.hash})
    ON CONFLICT (watcher_id) DO UPDATE
      SET block_height = EXCLUDED.block_height,
          block_hash   = EXCLUDED.block_hash,
          updated_at   = now()
  `;
}
