/**
 * Simple SQL migration runner.
 *
 * Migrations are plain .sql files in backend/migrations/, numbered with a
 * leading zero-padded integer: 001_schema.sql, 002_indexes.sql, etc.
 *
 * Each migration runs inside a transaction. If it fails, the transaction is
 * rolled back and the process exits non-zero.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node --import=tsx src/db/migrate.ts
 */

import postgres from 'postgres';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function run(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, {
    max: 1,
    types: { bigint: postgres.BigInt },
  });

  try {
    // Bootstrap the migration tracking table
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER      PRIMARY KEY,
        filename    TEXT         NOT NULL,
        applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `;

    const applied = await sql<{ version: number }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();

    let count = 0;
    for (const filename of files) {
      const version = parseInt(filename.split('_')[0]!, 10);
      if (appliedSet.has(version)) continue;

      const filepath = path.join(MIGRATIONS_DIR, filename);
      const sqlContent = fs.readFileSync(filepath, 'utf-8');

      console.log(`Applying migration ${filename}...`);
      await sql.begin(async (tx) => {
        // Run the migration SQL (may contain multiple statements)
        await tx.unsafe(sqlContent);
        await tx`
          INSERT INTO schema_migrations (version, filename)
          VALUES (${version}, ${filename})
        `;
      });
      console.log(`  ✓ ${filename}`);
      count++;
    }

    if (count === 0) {
      console.log('All migrations already applied.');
    } else {
      console.log(`\nApplied ${count} migration(s).`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
