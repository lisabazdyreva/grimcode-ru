import { createAdminPool } from '@template/shared/admin';
import {
  adminDatabaseUrl,
  createLogger,
  optionalEnv,
  requireEnv,
  serviceDatabaseName,
  serviceDatabaseRole,
  waitForDatabase,
  IDENTIFIER_LIMIT,
  type Pool,
} from '@template/shared';

import { DATABASE_MODULES } from '../wiring.js';

/**
 * Gives each module a database of its own and a role that can open nothing else.
 *
 * Worth being exact about what it buys: a query against a neighbour's table is caught by the
 * databases being separate, and opening a connection at all by `check-boundaries`. What the role
 * adds is the blast radius — one leaked password opens one database instead of five — and being the
 * only layer here nobody in this repository wrote: the checks can be weakened by editing a line, a
 * role without CONNECT keeps refusing. Idempotent, because it runs on every start.
 */

const logger = createLogger('db-init');

/** An identifier cannot be a bound parameter, so it is quoted; a password can be, and is not. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Ownership is transferred object by object rather than with `REASSIGN OWNED BY`.
 *
 * `REASSIGN OWNED` refuses outright when the source role owns anything the system needs — and
 * locally it does, because `DATABASE_URL` points at the cluster's bootstrap superuser:
 *
 *   ERROR: cannot reassign ownership of objects owned by role template
 *          because they are required by the database system
 *
 * It fails as a whole, so ownership would not move and the module could not read even its own
 * tables. Where the source is an ordinary role it would have worked — the kind of difference found
 * in production and not before. The `pg_depend` filter is not optional either: a sequence owned by a
 * table cannot be re-owned separately.
 */
function transferOwnership(role: string): string {
  return `
  DO $$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p','v','m','S')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.objid = c.oid AND d.deptype IN ('a','i')
        )
    LOOP
      EXECUTE format('ALTER %s %I OWNER TO %I',
        CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                       WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
        r.relname, ${literal(role)});
    END LOOP;
  END $$;
`;
}

/** Every identifier this run will create, so a collision is refused before anything is written. */
function plan() {
  return DATABASE_MODULES.map((module) => ({
    module,
    database: serviceDatabaseName(module),
    role: serviceDatabaseRole(module),
    password: requireEnv(`DB_PASSWORD_${module.toUpperCase()}`),
  }));
}

/**
 * Two modules whose names survive truncation identically would share one role, and the isolation
 * this file exists for would be gone without a single error. `PROJECT_SLUG` is free-form, and a
 * long one leaves only a few bytes to tell the modules apart.
 */
function assertDistinct(entries: ReturnType<typeof plan>): void {
  for (const kind of ['database', 'role'] as const) {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const clash = seen.get(entry[kind]);
      if (clash !== undefined) {
        throw new Error(
          `PROJECT_SLUG is too long: the ${kind} names of "${clash}" and "${entry.module}" are ` +
            `both "${entry[kind]}" once PostgreSQL truncates them to ${IDENTIFIER_LIMIT} bytes. ` +
            'Shorten PROJECT_SLUG; two modules sharing one role would share their data.',
        );
      }
      seen.set(entry[kind], entry.module);
    }
  }
}

async function ensureDatabase(admin: Pool, database: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (rowCount) return false;

  // No parameters here and none possible: an identifier cannot be bound, so it is quoted instead.
  await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  return true;
}

async function ensureRole(admin: Pool, role: string, password: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);

  if (rowCount) {
    // The password is re-stated every run, so rotating it is one edit in the environment.
    await admin.query(`ALTER ROLE ${quote(role)} WITH LOGIN PASSWORD ${literal(password)}`);
    return false;
  }

  await admin.query(`CREATE ROLE ${quote(role)} WITH LOGIN PASSWORD ${literal(password)}`);
  return true;
}

async function main(): Promise<void> {
  const entries = plan();
  assertDistinct(entries);

  const admin = createAdminPool(adminDatabaseUrl());
  await waitForDatabase(admin);

  for (const { module, database, role, password } of entries) {
    const createdRole = await ensureRole(admin, role, password);
    const createdDatabase = await ensureDatabase(admin, database);

    await admin.query(`ALTER DATABASE ${quote(database)} OWNER TO ${quote(role)}`);

    /*
     * `REVOKE CONNECT` is what makes the refusal arrive on connection rather than on the first
     * `SELECT`. Verified on a live server: before it, a foreign role connects and only fails on a
     * query — `permission denied for table sessions`; after it, the connection itself is refused
     * with `FATAL: permission denied for database … User does not have CONNECT privilege`.
     */
    await admin.query(`REVOKE CONNECT ON DATABASE ${quote(database)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(role)}`);

    /*
     * The database console needs `CONNECT` back, and nothing would show that it is missing: an
     * account narrowed for Adminer gets exactly one privilege from `PUBLIC`. No right to read is
     * granted here — that is decided by whoever created the account.
     */
    const consoleRole = optionalEnv('ADMINER_USERNAME', '');
    if (consoleRole !== '') {
      await admin.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(consoleRole)}`);
    }

    /*
     * Ownership of the objects inside is a one-time migration, for a database that already held
     * tables when this role first appeared: every table belongs to the old user, and the next
     * migration stops with `must be owner of table`. Keyed on the role, which is created once,
     * rather than the database, which exists on every restart.
     */
    if (createdRole) {
      const owned = createAdminPool(databaseUrlFor(database));
      try {
        await owned.query(transferOwnership(role));
      } finally {
        await owned.end();
      }
    }

    logger.info('module database ready', {
      module,
      database,
      role,
      createdDatabase,
      createdRole,
      ownershipTransferred: createdRole,
      consoleGranted: consoleRole !== '',
    });
  }

  await admin.end();
}

/** The same server as the admin connection, pointed at one database. */
function databaseUrlFor(database: string): string {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

await main();
