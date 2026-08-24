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
 * `~` only when the number really is approximate: the tilde used to sit in front of a zero that meant
 * "the planner has not looked at this table yet", which reads as "empty" and was wrong.
 */
export function rowCountLabel(rows: { count: number; approximate: boolean }): string {
  if (!rows.approximate) return String(rows.count);
  return rows.count === 0 ? '~0' : `~${rows.count}`;
}
