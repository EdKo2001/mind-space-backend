import { Pool } from 'pg';

export interface DatabaseProbe { check(): Promise<boolean>; close(): Promise<void> }
/** Connection readiness only. No session persistence/migration is silently enabled. */
export function createDatabaseProbe(connectionString?: string): DatabaseProbe {
  if (!connectionString) return { async check() { return false; }, async close() {} };
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL configuration');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000,
    query_timeout: 2000, statement_timeout: 2000 });
  // Do not log connection strings, raw database errors or credentials.
  pool.on('error', () => {});
  return {
    async check() {
      try { await pool.query('SELECT 1'); return true; } catch { return false; }
    },
    async close() { await pool.end(); },
  };
}
