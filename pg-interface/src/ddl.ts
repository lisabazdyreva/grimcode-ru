/**
 * The three statements that change a table's shape, and the rules that make them safe to build.
 *
 * DDL cannot be parameterised — PostgreSQL takes no `$1` in `ALTER TABLE` — so everything here ends up
 * in the text of a statement. That is why this file accepts so little: a name that matches a strict
 * pattern, and a type from a closed list. There is no value to place anywhere, because a column added
 * from the interface is always nullable and has no default; filling the existing rows is a row edit,
 * which goes through the parameterised path like every other value in this package.
 */

import { quote, qualify, RequestError, type Table } from './identifiers.js';

/**
 * Types a column may be given.
 *
 * A closed list rather than whatever `information_schema` might report: this is what a person can pick
 * from, and every one of them is a type the screen already knows how to show and filter. Keys are what
 * a request sends; values are what PostgreSQL is told.
 */
export const COLUMN_TYPES: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
  date: 'date',
  uuid: 'uuid',
  jsonb: 'jsonb',
};

/**
 * Tables this interface never reshapes.
 *
 * `schema_migrations` is how a module knows what it has applied, and `pg_interface_changes` is this
 * package's own journal. A column added to either would be read as a record of something that never
 * happened.
 */
export const PROTECTED_TABLES = new Set(['schema_migrations', 'pg_interface_changes']);

/**
 * A column name, checked before it can reach a statement.
 *
 * Deliberately narrower than what PostgreSQL accepts inside quotes: a name with a space, a dot or
 * cyrillic in it is legal SQL and a nuisance in every URL, filter and column menu afterwards. 63 bytes
 * is where PostgreSQL truncates an identifier — silently, which is how this project once ended up with
 * five databases named after a truncated slug.
 */
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NAME_LIMIT = 63;

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new RequestError(
      400,
      'A column name starts with a letter or underscore and holds only letters, digits and underscores.',
    );
  }

  if (Buffer.byteLength(name, 'utf8') > NAME_LIMIT) {
    throw new RequestError(400, `A column name is at most ${NAME_LIMIT} bytes; PostgreSQL cuts the rest.`);
  }

  return name;
}

/** The table a reshaping request names, refused when the table is one this interface protects. */
export function checkReshapable(table: Table): Table {
  if (PROTECTED_TABLES.has(table.name)) {
    throw new RequestError(400, `The shape of ${table.name} belongs to this project, not to this interface.`);
  }
  return table;
}

export function typeOf(requested: unknown): string {
  if (typeof requested !== 'string' || !(requested in COLUMN_TYPES)) {
    throw new RequestError(
      400,
      `A column is one of these types: ${Object.keys(COLUMN_TYPES).join(', ')}.`,
    );
  }
  return COLUMN_TYPES[requested] as string;
}

/**
 * `ADD COLUMN`, always nullable.
 *
 * Nullable is not a simplification, it is what keeps the module's code working: its `INSERT` names the
 * columns it knows, and a column it has never heard of has to be satisfied by leaving it out. `NOT NULL`
 * would make the next insert fail, from a screen that has no way of knowing which code inserts what.
 */
export function addColumn(table: Table, column: string, type: string): string {
  if (table.columns.some((existing) => existing.name === column)) {
    throw new RequestError(400, `${table.schema}.${table.name} already has a column ${column}.`);
  }

  return `ALTER TABLE ${qualify(table)} ADD COLUMN ${quote(column)} ${type}`;
}

export function renameColumn(table: Table, column: string, to: string): string {
  if (table.columns.some((existing) => existing.name === to)) {
    throw new RequestError(400, `${table.schema}.${table.name} already has a column ${to}.`);
  }

  return `ALTER TABLE ${qualify(table)} RENAME COLUMN ${quote(column)} TO ${quote(to)}`;
}

export function dropColumn(table: Table, column: string): string {
  return `ALTER TABLE ${qualify(table)} DROP COLUMN ${quote(column)}`;
}
