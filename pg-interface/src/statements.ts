import { whereClause, orderClause } from './filters.js';
import {
  findColumn,
  Parameters,
  qualify,
  quote,
  RequestError,
  type Table,
} from './identifiers.js';

/** How many rows one page may hold, whatever a request asks for. */
export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 50;

export interface Statement {
  text: string;
  values: unknown[];
}

export interface Page {
  limit: number;
  offset: number;
}

/** The page a request asked for, clamped. A huge `limit` is a mistake, not a permission. */
export function pageOf(body: { limit?: unknown; offset?: unknown }): Page {
  const limit = whole(body.limit, DEFAULT_PAGE, 'limit');
  const offset = whole(body.offset, 0, 'offset');

  return { limit: Math.min(Math.max(limit, 1), MAX_PAGE), offset: Math.max(offset, 0) };
}

function whole(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RequestError(400, `${name} is a whole number.`);
  }
  return value;
}

/** The rows of one page, and the statement that counts every row the same filters match. */
export function selectRows(
  table: Table,
  body: { filters?: unknown; combine?: unknown; order?: unknown; limit?: unknown; offset?: unknown },
): { rows: Statement; total: Statement } {
  const page = pageOf(body);

  const rowParameters = new Parameters();
  const where = whereClause(table, body.filters, body.combine, rowParameters);
  const order = orderClause(table, body.order);

  const columns = table.columns.map((column) => quote(column.name)).join(', ');
  const filtered = where === null ? '' : ` WHERE ${where}`;
  const sorted = order === null ? '' : ` ORDER BY ${order}`;

  const rows = {
    text:
      `SELECT ${columns} FROM ${qualify(table)}${filtered}${sorted} ` +
      `LIMIT ${rowParameters.add(page.limit)} OFFSET ${rowParameters.add(page.offset)}`,
    values: rowParameters.values,
  };

  /*
   * The count is its own statement with its own parameters rather than a window function beside the
   * rows: `count(*) OVER ()` returns nothing at all when the page is empty, and a person on page ten
   * of a table that shrank would be told the table is empty.
   */
  const countParameters = new Parameters();
  const countWhere = whereClause(table, body.filters, body.combine, countParameters);

  const total = {
    text: `SELECT count(*)::bigint AS total FROM ${qualify(table)}${
      countWhere === null ? '' : ` WHERE ${countWhere}`
    }`,
    values: countParameters.values,
  };

  return { rows, total };
}

/**
 * The `WHERE` that addresses exactly one row.
 *
 * Every primary key column must be present and nothing else may be: a key with one column missing
 * would match a set of rows, and an update or a delete would take them all. A table without a
 * primary key is refused here rather than addressed by its contents — matching on every column would
 * hit both of two identical rows, and there is no honest way to tell them apart.
 */
function keyClause(table: Table, key: unknown, parameters: Parameters): string {
  if (table.primaryKey.length === 0) {
    throw new RequestError(
      409,
      `${table.schema}.${table.name} has no primary key, so a single row cannot be addressed. ` +
        'Rows here can be read but not changed.',
    );
  }

  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new RequestError(400, 'A key is an object of column names and values.');
  }

  const given = Object.keys(key as Record<string, unknown>);
  const missing = table.primaryKey.filter((column) => !given.includes(column));
  const extra = given.filter((column) => !table.primaryKey.includes(column));

  if (missing.length > 0 || extra.length > 0) {
    throw new RequestError(
      400,
      `The key of ${table.schema}.${table.name} is (${table.primaryKey.join(', ')}); ` +
        `received (${given.join(', ') || 'nothing'}).`,
    );
  }

  return table.primaryKey
    .map((column) => {
      const value = (key as Record<string, unknown>)[column];
      if (value === null || value === undefined) {
        throw new RequestError(400, `The key column ${column} has no value.`);
      }
      return `${quote(findColumn(table, column).name)} = ${parameters.add(value)}`;
    })
    .join(' AND ');
}

/**
 * Changing the columns of one row.
 *
 * Key columns are refused: the row is addressed by its key, so changing the key in the same
 * statement is a rename, and a rename of a row other rows point at is not a thing to do by
 * accident. Deleting the row and inserting the new one is the honest way to say that.
 */
export function updateRow(
  table: Table,
  body: { key?: unknown; values?: unknown },
): Statement {
  if (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values)) {
    throw new RequestError(400, 'Values are an object of column names and values.');
  }

  const values = body.values as Record<string, unknown>;
  const names = Object.keys(values);
  if (names.length === 0) throw new RequestError(400, 'Nothing to change.');

  const keyColumns = names.filter((name) => table.primaryKey.includes(name));
  if (keyColumns.length > 0) {
    throw new RequestError(
      400,
      `${keyColumns.join(', ')} identifies the row and cannot be changed here.`,
    );
  }

  const parameters = new Parameters();
  const assignments = names
    .map((name) => `${quote(findColumn(table, name).name)} = ${parameters.add(values[name])}`)
    .join(', ');

  const where = keyClause(table, body.key, parameters);

  return {
    text: `UPDATE ${qualify(table)} SET ${assignments} WHERE ${where}`,
    values: parameters.values,
  };
}

/** Removing one row, addressed the same way. */
export function deleteRow(table: Table, body: { key?: unknown }): Statement {
  const parameters = new Parameters();
  const where = keyClause(table, body.key, parameters);

  return {
    text: `DELETE FROM ${qualify(table)} WHERE ${where}`,
    values: parameters.values,
  };
}
