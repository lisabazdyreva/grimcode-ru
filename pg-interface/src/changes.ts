/**
 * The journal of shape changes this interface made, kept in the database it changed.
 *
 * Two things depend on it, and the second is why it is not decoration:
 *
 * - **a person can see what was done** — what, where, when, and the exact statement;
 * - **only a column this interface added may be renamed or dropped.** The schema of this project
 *   belongs to each module's migrations; a column the module's code reads would take the module down
 *   the moment it were renamed. The journal is the only way to tell the two kinds of column apart —
 *   nothing in `information_schema` says who created what.
 *
 * The journal lives in the same database as the table it describes, so a dump carries both, and a
 * database restored elsewhere arrives with its history.
 */

import { createHash } from 'node:crypto';

import type { Queryable } from './catalog.js';

export const JOURNAL_TABLE = 'pg_interface_changes';

/** Namespace for the advisory lock that serialises version numbers. Arbitrary, but stable. */
const LOCK_KEY = 0x5f100001;

export type ChangeKind = 'add' | 'rename' | 'drop';

export interface Change {
  version: number;
  kind: ChangeKind;
  schema: string;
  table: string;
  /** The column the change is about. For a rename, the name it had before. */
  column: string;
  /** `type` for an add, `to` for a rename. Empty for a drop. */
  details: Record<string, unknown>;
  sql: string;
  appliedAt: string | null;
}

/**
 * A client that can hold a transaction.
 *
 * `Queryable` is a pool, and a pool hands each query whatever connection is free — `BEGIN` on one
 * connection and `ALTER TABLE` on another is not a transaction. So a change asks for a connection of
 * its own. PostgreSQL runs DDL inside a transaction, which is what makes "applied but not recorded"
 * impossible here.
 */
export interface Transactional extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

function transactional(pool: Queryable): pool is Transactional {
  return typeof (pool as { connect?: unknown }).connect === 'function';
}

/** Called from the writing path only — see `readJournal` for why reading must not create it. */
async function ensureJournal(pool: Queryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
      version     integer PRIMARY KEY,
      kind        text NOT NULL CHECK (kind IN ('add', 'rename', 'drop')),
      "schema"    text NOT NULL,
      "table"     text NOT NULL,
      "column"    text NOT NULL,
      details     jsonb NOT NULL DEFAULT '{}'::jsonb,
      sql         text NOT NULL,
      checksum    text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      -- Null means recorded but not yet run here: that is what a journal carried from another
      -- installation looks like before it is applied.
      applied_at  timestamptz
    )
  `);
}

interface JournalRow {
  version: number;
  kind: ChangeKind;
  schema: string;
  table: string;
  column: string;
  details: Record<string, unknown> | null;
  sql: string;
  applied_at: string | null;
}

/** PostgreSQL for "no such table" — here it means the journal has not been started yet. */
const UNDEFINED_TABLE = '42P01';

function undefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

/**
 * The journal of one database, oldest first. Empty when this interface has never changed anything.
 *
 * Reading does not create the table: a missing journal is an answer, not a failure. Creating it here
 * would mean looking at a table changes the schema, and would demand `CREATE` on the schema from a
 * reader — measured, a role without it is refused `42501` even when the table already exists.
 */
export async function readJournal(pool: Queryable): Promise<Change[]> {
  let rows: JournalRow[];

  try {
    ({ rows } = await pool.query<JournalRow>(
      `SELECT version, kind, "schema", "table", "column", details, sql, applied_at
         FROM ${JOURNAL_TABLE}
        ORDER BY version`,
    ));
  } catch (error) {
    if (undefinedTable(error)) return [];
    throw error;
  }

  return rows.map((row) => ({
    version: row.version,
    kind: row.kind,
    schema: row.schema,
    table: row.table,
    column: row.column,
    details: row.details ?? {},
    sql: row.sql,
    appliedAt: row.applied_at,
  }));
}

/**
 * Which columns this interface owns, worked out by replaying the journal.
 *
 * Replayed rather than kept as a second table: two records of the same fact drift, and this one is
 * cheap — a handful of rows read once per request that needs it. Keys are `schema.table.column`.
 */
export function ownColumns(changes: Change[]): Set<string> {
  const owned = new Set<string>();
  const at = (change: Change, column: string) => `${change.schema}.${change.table}.${column}`;

  for (const change of changes) {
    if (change.appliedAt === null) continue;

    if (change.kind === 'add') owned.add(at(change, change.column));
    if (change.kind === 'drop') owned.delete(at(change, change.column));
    if (change.kind === 'rename') {
      const to = typeof change.details.to === 'string' ? change.details.to : '';
      owned.delete(at(change, change.column));
      if (to) owned.add(at(change, to));
    }
  }

  return owned;
}

export interface ChangeRequest {
  kind: ChangeKind;
  schema: string;
  table: string;
  column: string;
  details: Record<string, unknown>;
  sql: string;
}

/**
 * Runs one change and records it, both or neither.
 *
 * The version number is taken under an advisory lock, so two people adding a column at the same moment
 * get two versions rather than one collision.
 */
export async function applyChange(pool: Queryable, change: ChangeRequest): Promise<number> {
  await ensureJournal(pool);

  if (!transactional(pool)) return await write(pool, change);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version = await write(client, change);
    await client.query('COMMIT');
    return version;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function write(client: Queryable, change: ChangeRequest): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

  const { rows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM ${JOURNAL_TABLE}`,
  );
  const version = rows[0]?.next ?? 1;

  await client.query(
    `INSERT INTO ${JOURNAL_TABLE} (version, kind, "schema", "table", "column", details, sql, checksum)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      version,
      change.kind,
      change.schema,
      change.table,
      change.column,
      JSON.stringify(change.details),
      change.sql,
      checksumOf(change.sql),
    ],
  );

  // The statement itself. It is built in `ddl.ts` and nowhere else, from a checked name and a type out
  // of a closed list — this is the one place in the package that runs SQL it did not parameterise.
  await client.query(change.sql);

  await client.query(`UPDATE ${JOURNAL_TABLE} SET applied_at = now() WHERE version = $1`, [version]);

  return version;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.trim(), 'utf8').digest('hex');
}
