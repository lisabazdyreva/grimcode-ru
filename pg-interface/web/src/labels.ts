/** What a condition is called on screen. The ids are the server's; these are for people. */
export const CONDITION_LABELS: Record<string, string> = {
  is: 'равно',
  'is-not': 'не равно',
  contains: 'содержит',
  'not-contains': 'не содержит',
  'starts-with': 'начинается с',
  'ends-with': 'заканчивается на',
  equals: 'равно',
  'not-equals': 'не равно',
  'greater-than': 'больше',
  'less-than': 'меньше',
  'is-empty': 'пусто',
  'is-not-empty': 'не пусто',
};

/** Conditions that ask about presence, so the value field is hidden for them. */
export const WITHOUT_VALUE = new Set(['is-empty', 'is-not-empty']);

/** A cell as text: short enough to read in a row, and never a broken `[object Object]`. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** How much of one value a table cell shows. The rest is in the row's own dialog. */
export const CELL_LIMIT = 600;

/**
 * How many rows a table has, as the list shows it.
 *
 * `~` only on a table too large to count, where it means "more than we are willing to read". Small
 * tables are counted exactly, so the tilde never sits beside a number a person could check by hand.
 */
export function rowCountLabel(rows: { count: number; approximate: boolean }): string {
  return rows.approximate ? `~${rows.count}` : String(rows.count);
}

/**
 * A type name short enough to sit beside a column name.
 *
 * `information_schema` spells types out in full — `timestamp with time zone`, `character varying` —
 * and in a table header that wraps onto three lines and makes every header as tall as the longest
 * name. These are PostgreSQL's own short forms, the ones `psql \d` prints; the full name stays in the
 * element's title.
 */
const SHORT_TYPES: [RegExp, string][] = [
  [/^timestamp with time zone$/, 'timestamptz'],
  [/^timestamp without time zone$/, 'timestamp'],
  [/^time with time zone$/, 'timetz'],
  [/^time without time zone$/, 'time'],
  [/^character varying$/, 'varchar'],
  [/^character$/, 'char'],
  [/^double precision$/, 'float8'],
  [/^boolean$/, 'bool'],
  [/^integer$/, 'int'],
  [/^smallint$/, 'int2'],
  [/^bigint$/, 'int8'],
  [/^numeric$/, 'numeric'],
];

export function shortType(type: string): string {
  for (const [pattern, short] of SHORT_TYPES) if (pattern.test(type)) return short;
  return type;
}
