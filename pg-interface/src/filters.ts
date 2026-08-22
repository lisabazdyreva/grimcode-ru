import { findColumn, quote, RequestError, type Parameters, type Table } from './identifiers.js';

/**
 * The conditions a person can put on a column, and nothing beyond them.
 *
 * A closed list on purpose: the alternative is accepting a fragment of SQL from the browser, and
 * then every other guard in this package is decoration. Text conditions and comparison conditions
 * are separate because "contains" on a number and "greater than" on a name are both nonsense, and
 * the interface should offer neither.
 */
export const TEXT_CONDITIONS = [
  'is',
  'is-not',
  'contains',
  'not-contains',
  'starts-with',
  'ends-with',
  'is-empty',
  'is-not-empty',
] as const;

export const VALUE_CONDITIONS = [
  'equals',
  'not-equals',
  'greater-than',
  'less-than',
  'is-empty',
  'is-not-empty',
] as const;

export type Condition = (typeof TEXT_CONDITIONS)[number] | (typeof VALUE_CONDITIONS)[number];

/** Which conditions apply to a column, by what `information_schema` calls its type. */
export function conditionsFor(type: string): readonly Condition[] {
  return isTextual(type) ? TEXT_CONDITIONS : VALUE_CONDITIONS;
}

function isTextual(type: string): boolean {
  return /char|text|uuid|json|enum|name/i.test(type);
}

/** Conditions that ask about presence rather than content, so they carry no value. */
const WITHOUT_VALUE = new Set<Condition>(['is-empty', 'is-not-empty']);

export interface Filter {
  column: string;
  condition: Condition;
  value?: unknown;
}

export type Combine = 'and' | 'or';

/**
 * Turns the filters of a request into one SQL fragment.
 *
 * Every column is looked up in the table, every condition is one of the two lists above, and every
 * value becomes a parameter. What comes back is a fragment for `WHERE`, or null when there is
 * nothing to filter by.
 */
export function whereClause(
  table: Table,
  filters: unknown,
  combine: unknown,
  parameters: Parameters,
): string | null {
  if (filters === undefined || filters === null) return null;
  if (!Array.isArray(filters)) throw new RequestError(400, 'Filters are a list.');
  if (filters.length === 0) return null;

  const joiner = combineOf(combine);
  const fragments = filters.map((filter) => fragmentOf(table, filter, parameters));

  return fragments.join(` ${joiner.toUpperCase()} `);
}

function combineOf(combine: unknown): Combine {
  if (combine === undefined || combine === null) return 'and';
  if (combine !== 'and' && combine !== 'or') {
    throw new RequestError(400, 'Filters are combined with "and" or "or".');
  }
  return combine;
}

function fragmentOf(table: Table, filter: unknown, parameters: Parameters): string {
  if (typeof filter !== 'object' || filter === null) {
    throw new RequestError(400, 'A filter is an object with a column and a condition.');
  }

  const { column: columnName, condition, value } = filter as Filter;
  const column = findColumn(table, columnName);
  const allowed = conditionsFor(column.type);

  if (!allowed.includes(condition)) {
    throw new RequestError(
      400,
      `Condition "${String(condition)}" does not apply to ${column.name} (${column.type}).`,
    );
  }

  const target = quote(column.name);

  if (WITHOUT_VALUE.has(condition)) {
    // Empty means "nothing there": null, and for text the empty string as well, because a person
    // filtering an empty cell does not care which of the two the column happens to hold.
    const empty = isTextual(column.type) ? `(${target} IS NULL OR ${target} = '')` : `${target} IS NULL`;
    return condition === 'is-empty' ? empty : `NOT ${empty}`;
  }

  if (value === undefined || value === null) {
    throw new RequestError(400, `Condition "${condition}" needs a value.`);
  }

  switch (condition) {
    case 'is':
    case 'equals':
      return `${target} = ${parameters.add(value)}`;
    case 'is-not':
    case 'not-equals':
      return `${target} <> ${parameters.add(value)}`;
    case 'greater-than':
      return `${target} > ${parameters.add(value)}`;
    case 'less-than':
      return `${target} < ${parameters.add(value)}`;
    /*
     * `ILIKE` on the text of the column rather than on the column itself: a uuid or a timestamp has
     * no `ILIKE`, and casting is what lets "contains" mean the same thing everywhere in the
     * interface. The pattern is a parameter, and the wildcards are added to the value, not to the
     * SQL — so a `%` a person typed is a literal `%`.
     */
    case 'contains':
      return `${target}::text ILIKE ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'not-contains':
      return `${target}::text NOT ILIKE ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'starts-with':
      return `${target}::text ILIKE ${parameters.add(`${escapeLike(value)}%`)}`;
    case 'ends-with':
      return `${target}::text ILIKE ${parameters.add(`%${escapeLike(value)}`)}`;
    default:
      throw new RequestError(400, `Unknown condition "${String(condition)}".`);
  }
}

/**
 * A pattern the person typed is text, not syntax: `50%` finds `50%` and not "starts with 50".
 * `\` is the default escape character in `LIKE`, so it has to be escaped first.
 */
function escapeLike(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/[%_]/g, (character) => `\\${character}`);
}

export interface Order {
  column: string;
  direction: 'asc' | 'desc';
}

/** `ORDER BY` from what a request asked for, or null. Directions are a pair, never a string. */
export function orderClause(table: Table, order: unknown): string | null {
  if (order === undefined || order === null) return null;
  if (!Array.isArray(order)) throw new RequestError(400, 'Sorting is a list.');
  if (order.length === 0) return null;

  const fragments = order.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RequestError(400, 'A sort entry is an object with a column and a direction.');
    }
    const { column: columnName, direction } = entry as Order;
    const column = findColumn(table, columnName);

    if (direction !== 'asc' && direction !== 'desc') {
      throw new RequestError(400, 'A direction is "asc" or "desc".');
    }

    // Nulls last in both directions: they are the least interesting rows either way, and PostgreSQL's
    // default puts them first on `DESC`, which reads as an error in a table.
    return `${quote(column.name)} ${direction.toUpperCase()} NULLS LAST`;
  });

  return fragments.join(', ');
}
