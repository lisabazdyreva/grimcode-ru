import pg from 'pg';

import { runMigrations, waitForDatabase } from '@template/shared';

import type { AuthEnv } from '../env.js';
import { migrations } from './migrations.js';

export type Pool = pg.Pool;

// Five modules share this process and the server's 100 connections; the sum is what matters.
const MAX_CONNECTIONS = 5;

/**
 * This module's database, prepared on the first request that needs it: created if missing, migrated,
 * checked, kept. There is no deployment step behind it — the cost is that a broken migration answers
 * 500 to the first person through the door instead of failing a deploy.
 */
export function createDatabase(): (env: AuthEnv) => Promise<Pool> {
  const open = async (env: AuthEnv): Promise<Pool> => {
    await ensureDatabase(env);

    const pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'auth-service',
    });

    /*
     * Registered and empty on purpose: without a listener a broken idle connection takes the process
     * down, with every module in it. Nothing is reported here — the request that needs the pool fails
     * on its own, and that is what is visible.
     */
    pool.on('error', () => undefined);

    try {
      await assertOpenedDatabase(pool, env.databaseName);
      await runMigrations(pool, migrations);
    } catch (error) {
      // The attempt is retried, so its connections must not be left behind.
      await pool.end().catch(() => undefined);
      throw error;
    }

    return pool;
  };

  return openOnce(open);
}

/**
 * Remembers the first successful call: the promise, not the value, so two requests arriving together
 * share one attempt. A failure is forgotten, so a server that was not up yet is retried by the next
 * request instead of refusing until restart.
 *
 * Exported because those two sentences are what can go wrong here, and the rest of this file needs a
 * live PostgreSQL to say anything.
 */
export function openOnce<TArg, TValue>(
  open: (arg: TArg) => Promise<TValue>,
): (arg: TArg) => Promise<TValue> {
  let opening: Promise<TValue> | undefined;

  return (arg) =>
    (opening ??= open(arg).catch((error: unknown) => {
      opening = undefined;
      throw error;
    }));
}

/**
 * Creates this module's database unless it is already there. A database cannot be created from inside
 * itself, hence the second connection, closed again straight away; `waitForDatabase` is what makes a
 * cold start work.
 */
async function ensureDatabase(env: AuthEnv): Promise<void> {
  const server = new pg.Pool({
    connectionString: env.maintenanceUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'auth-create',
  });

  server.on('error', () => undefined);

  try {
    await waitForDatabase(server);

    const { rowCount } = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      env.databaseName,
    ]);
    if (rowCount) return;

    try {
      // An identifier cannot be a bound parameter, so it is quoted instead.
      await server.query(`CREATE DATABASE "${env.databaseName.replace(/"/g, '""')}"`);
    } catch (error) {
      // Two instances starting together both find it missing; the loser gets this and wanted it.
      if ((error as { code?: string }).code !== '42P04') throw error;
    }
  } finally {
    await server.end().catch(() => undefined);
  }
}

/**
 * Refuses a pool that landed on another database. One account opens every database on the server, so
 * this is the whole of what stands between a mistyped `DATABASE_URL_<MODULE>` and this module's tables
 * appearing in a neighbour's database. It runs before the migrations for that reason.
 */
export async function assertOpenedDatabase(pool: Pool, expected: string): Promise<void> {
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
  const opened = rows[0]?.current_database;
  if (opened !== expected) {
    throw new Error(`Pool opened database "${opened}", expected "${expected}"`);
  }
}
