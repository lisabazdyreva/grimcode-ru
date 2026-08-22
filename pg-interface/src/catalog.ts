import type { Column, Table } from './identifiers.js';

/** What the interface needs to run a query, and the only source of table and column names. */
export interface Catalogue {
  tables: Table[];
}

/** A pool, as little of one as this package needs. */
export interface Queryable {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * Schemas that belong to PostgreSQL rather than to the project. Excluded rather than listing the
 * project's own, because a module is free to create a schema and the interface should show it.
 */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

interface KeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  position: number;
}

/**
 * Reads the catalogue of one database.
 *
 * Two queries and no joins between them: the columns of every table, and the primary key columns of
 * every table that has one. Tables are what `information_schema` calls `BASE TABLE` — a view has no
 * key to address a row by, and this interface changes rows.
 *
 * Read on every request that needs it, not remembered: a migration runs on the first request to a
 * module, so a catalogue cached at start-up would describe the database as it was before the modules
 * woke up.
 */
export async function readCatalogue(pool: Queryable): Promise<Catalogue> {
  const { rows: columnRows } = await pool.query<ColumnRow>(
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema <> ALL ($1) AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    [SYSTEM_SCHEMAS],
  );

  const { rows: keyRows } = await pool.query<KeyRow>(
    `SELECT tc.table_schema, tc.table_name, kcu.column_name, kcu.ordinal_position AS position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema <> ALL ($1)
      ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
    [SYSTEM_SCHEMAS],
  );

  const keys = new Map<string, string[]>();
  for (const row of keyRows) {
    const at = `${row.table_schema}.${row.table_name}`;
    keys.set(at, [...(keys.get(at) ?? []), row.column_name]);
  }

  const tables = new Map<string, Table>();
  for (const row of columnRows) {
    const at = `${row.table_schema}.${row.table_name}`;
    const column: Column = {
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    };

    const table = tables.get(at);
    if (table) table.columns.push(column);
    else {
      tables.set(at, {
        schema: row.table_schema,
        name: row.table_name,
        columns: [column],
        primaryKey: keys.get(at) ?? [],
      });
    }
  }

  return { tables: [...tables.values()] };
}

/**
 * How many rows a table holds, roughly.
 *
 * `reltuples` is what the planner keeps and costs nothing to read; `count(*)` reads the whole table,
 * which is not a price a list of tables should pay. It is an estimate, and the interface says so —
 * the exact number for a filtered view comes with the rows themselves.
 */
export async function estimateRows(pool: Queryable, table: Table): Promise<number> {
  const { rows } = await pool.query<{ estimate: string }>(
    `SELECT GREATEST(c.reltuples, 0)::bigint AS estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [table.schema, table.name],
  );

  return Number(rows[0]?.estimate ?? 0);
}
