import pg from 'pg';

import type { Pool } from './pool.js';

/**
 * A pool for the role that owns the server, opened from a connection string given by the caller.
 *
 * `createPool(module)` derives its string from the module's own credentials; `db-init` needs the
 * opposite, the role from `DATABASE_URL` that creates roles and revokes `CONNECT`.
 *
 * **The name is meant to be alarming.** Called `createPoolFromUrl`, this would eventually be written
 * as `createPoolFromUrl(process.env.DATABASE_URL)` inside a module, past the roles entirely. It is
 * reachable only as `@template/shared/admin` and never re-exported from the barrel.
 */
export function createAdminPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    // One caller, a handful of statements, and it exits when it is done.
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'db-init',
  });

  pool.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', message: 'idle admin pool client failed', error: error.message })}\n`,
    );
  });

  return pool;
}
