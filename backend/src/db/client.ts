/**
 * PostgreSQL client factory.
 *
 * Uses the `postgres` package (porsager) for its ergonomic tagged-template API
 * and first-class TypeScript support.
 *
 * Notable configuration:
 *  - int8 (BIGINT) columns are parsed as JavaScript BigInt, not string.
 *  - Connections are pooled (max 10 by default).
 *  - SSL is required in production (DATABASE_URL must include ?ssl=require or
 *    the SSL_CERT env var must be set).
 */

import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

let _sql: Sql | null = null;

export function getDb(): Sql {
  if (_sql) return _sql;

  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL environment variable is not set');

  _sql = postgres(url, {
    max: parseInt(process.env['DB_POOL_MAX'] ?? '10'),
    idle_timeout: 30,
    connect_timeout: 10,

    // Parse BIGINT as BigInt instead of string
    types: {
      bigint: postgres.BigInt,
    },

    // Warn on slow queries in development
    debug: process.env['NODE_ENV'] === 'development'
      ? (connection, query, params) => {
          console.debug('[db]', query.slice(0, 120), params);
        }
      : undefined,
  });

  return _sql;
}

/** Close the connection pool — call on process exit. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
