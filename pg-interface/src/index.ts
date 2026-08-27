import { countRows, readCatalogue } from './catalog.js';
import { applyChange, ownColumns, readJournal, type ChangeKind } from './changes.js';
import {
  addColumn,
  checkName,
  checkReshapable,
  dropColumn,
  PROTECTED_TABLES,
  renameColumn,
} from './ddl.js';
import { conditionsFor } from './filters.js';
import { findColumn, findTable, RequestError, type Table } from './identifiers.js';
import {
  createPools,
  UnknownDatabase,
  type Connect,
  type DatabaseSource,
} from './pools.js';
import { deleteRow, insertRow, selectRows, updateRow } from './statements.js';
import { serveScreen } from './static.js';

export type { DatabaseSource } from './pools.js';
export { MAX_PAGE } from './statements.js';

/**
 * A database interface for the databases it is handed, and nothing else.
 *
 * It answers requests and knows nothing about who is asking: whoever mounts it decides that. In this
 * template that is Gateway, which lets only the owner of the admin panel through — the same check
 * the third-party console behind this section used to sit behind.
 *
 * One rule the package keeps for itself, because nothing outside it can: **identifiers are looked up,
 * values are parameters.** See `identifiers.ts`.
 *
 * It reports nothing anywhere, and that is the second rule, now kept by there being nothing to report
 * with: these databases hold password hashes and session identifiers, and anything written down is
 * something kept and forwarded.
 */
export interface DatabaseInterfaceOptions {
  databases: DatabaseSource[];
  /** Where this interface is mounted, so it can tell its own paths from the rest of the URL. */
  basePath: string;
  /** How a database is opened. Real pools unless a test says otherwise. */
  connect?: Connect;
}

export interface DatabaseInterface {
  /** Answers a request the same way a module does, so a router can treat it as one. */
  fetch(request: Request): Promise<Response>;
  /** Closes the connections it opened. */
  end(): Promise<void>;
}

/**
 * The header a changing request has to carry.
 *
 * This is the package's own protection against a request sent by another site: a cross-site `<form>`
 * cannot add a header, and a cross-site `fetch` that adds one is stopped by the preflight this
 * package never answers — it sends no CORS headers at all, so no other origin is allowed anything.
 *
 * It is written down here rather than borrowed from the application on purpose. The repository's
 * mechanical check for CSRF reads tRPC procedures; this package is not one, so it would not be
 * covered by it whatever it did — which is exactly why the guard is its own and has its own test.
 */
export const REQUEST_HEADER = 'x-pg-interface';
export const REQUEST_HEADER_VALUE = '1';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

/**
 * The two classes of PostgreSQL error code that mean "your value", not "our database".
 *
 * `22` is a data exception — `invalid input syntax for type uuid`, a number out of range, a bad date.
 * `23` is a constraint the row would break — not-null, unique, a foreign key. Both are answers to what
 * the request carried, so they belong in a 4xx; everything else is this side failing and stays a 500.
 */
const INPUT_CLASSES = new Set(['22', '23']);

/**
 * `invalid_catalog_name`: there is no database of that name on the server.
 *
 * It means that and nothing else, which is why it can be told apart from this side failing. A server
 * that is down answers without a PostgreSQL code at all (`ECONNREFUSED`), and exhausted connections
 * are `53300`. Worth its own answer because a module creates its own database on the first request
 * that needs it, so a database this interface was handed may legitimately not exist yet.
 */
const ABSENT_DATABASE = '3D000';

/** The `code` PostgreSQL puts on its errors, or an empty string when the error is not one of its. */
function pgCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

export function createDatabaseInterface(options: DatabaseInterfaceOptions): DatabaseInterface {
  const pools = createPools(options.databases, options.connect);
  const base = options.basePath.replace(/\/$/, '');

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    const segments = path.split('/').filter(Boolean);

    // Everything that is not the API is the screen: its files, or its page for any other path.
    if (segments[0] !== 'api') {
      if (request.method !== 'GET') return methodNotAllowed();
      return await serveScreen(path);
    }

    if (request.method === 'GET' && segments.length === 2 && segments[1] === 'databases') {
      return json({ databases: pools.names().map((name) => ({ name })) });
    }

    if (segments[1] === 'databases' && segments.length === 4 && segments[3] === 'tables') {
      if (request.method !== 'GET') return methodNotAllowed();
      return await tables(decodeURIComponent(segments[2] ?? ''));
    }

    if (segments[1] === 'databases' && segments.length === 4 && segments[3] === 'rows') {
      if (request.method !== 'POST') return methodNotAllowed();
      return await rows(request, decodeURIComponent(segments[2] ?? ''));
    }

    if (segments[1] === 'databases' && segments.length === 5 && segments[3] === 'rows') {
      if (request.method !== 'POST') return methodNotAllowed();
      const action = segments[4];
      if (action === 'insert') return await insert(request, decodeURIComponent(segments[2] ?? ''));
      if (action !== 'update' && action !== 'delete') {
        return json({ error: 'not-found', message: `Unknown action "${action}".` }, 404);
      }
      return await change(request, decodeURIComponent(segments[2] ?? ''), action);
    }

    if (segments[1] === 'databases' && segments.length === 4 && segments[3] === 'columns') {
      if (request.method !== 'POST') return methodNotAllowed();
      return await reshape(request, decodeURIComponent(segments[2] ?? ''), 'add');
    }

    if (segments[1] === 'databases' && segments.length === 5 && segments[3] === 'columns') {
      if (request.method !== 'POST') return methodNotAllowed();
      const action = segments[4];
      if (action !== 'rename' && action !== 'drop') {
        return json({ error: 'not-found', message: `Unknown action "${action}".` }, 404);
      }
      return await reshape(request, decodeURIComponent(segments[2] ?? ''), action);
    }

    return json({ error: 'not-found', message: 'No such path in this interface.' }, 404);
  }

  /** The tables of one database, with the key each row is addressed by and a rough size. */
  async function tables(database: string): Promise<Response> {
    const pool = await pools.of(database);

    // Who added each column: `own` is what lets the screen offer rename and drop on some columns only.
    // The journal does not depend on the catalogue, so it is read in the same round.
    const [{ tables: found }, changes] = await Promise.all([readCatalogue(pool), readJournal(pool)]);
    const owned = ownColumns(changes);

    const described = await Promise.all(
      found.map(async (table) => ({
        schema: table.schema,
        name: table.name,
        primaryKey: table.primaryKey,
        rows: await countRows(pool, table),
        reshapable: !PROTECTED_TABLES.has(table.name),
        // The same two tables, and for the same reason: a row invented here would record something
        // that never happened. Sent apart from `reshapable` because adding a row and changing the
        // shape are different permissions, and one may outlive the other.
        insertable: !PROTECTED_TABLES.has(table.name),
        // What the table should open sorted by, decided here because the catalogue is what knows.
        naturalOrder: table.naturalOrder ?? null,
        columns: table.columns.map((column) => ({
          ...column,
          conditions: conditionsFor(column.type),
          own: owned.has(`${table.schema}.${table.name}.${column.name}`),
        })),
      })),
    );

    return json({ tables: described });
  }

  /** One page of rows, and how many rows the same filters match. */
  async function rows(request: Request, database: string): Promise<Response> {
    const body = await readBody(request);
    const pool = await pools.of(database);
    const table = findTable((await readCatalogue(pool)).tables, body.schema, body.table);

    const { rows: rowsStatement, total: totalStatement } = selectRows(table, body);

    /*
     * All three in one round: the journal does not depend on the page or the count, and reading it
     * after them made every page of rows wait a round trip for nothing.
     */
    const [page, counted, changes] = await Promise.all([
      pool.query<Record<string, unknown>>(rowsStatement.text, rowsStatement.values),
      pool.query<{ total: string }>(totalStatement.text, totalStatement.values),
      readJournal(pool),
    ]);


    /*
     * `own` belongs here as well as in the table list, and from the same place. The screen builds its
     * column menu from this answer, so a flag stitched together on the client from two answers would
     * disagree with itself the moment a column were renamed.
     */
    const owned = ownColumns(changes);

    return json({
      /*
       * The conditions belong here as much as in the table list, and for a plain reason: the filter
       * panel is built from this answer. Without them its menu of conditions was empty, and a filter
       * added from it fell back to "is" whatever the column was.
       */
      columns: table.columns.map((column) => ({
        ...column,
        conditions: conditionsFor(column.type),
        own: owned.has(`${table.schema}.${table.name}.${column.name}`),
      })),
      primaryKey: table.primaryKey,
      rows: page.rows,
      total: Number(counted.rows[0]?.total ?? 0),
    });
  }

  /**
   * Adding one row.
   *
   * The tables that record what has been applied are refused, the same two the shape of which this
   * interface will not touch: a hand-written row in `schema_migrations` would tell a module it has
   * already run a migration it has not, and one in the journal would claim a change nobody made.
   */
  async function insert(request: Request, database: string): Promise<Response> {
    const body = await readBody(request);
    const pool = await pools.of(database);
    const table = findTable((await readCatalogue(pool)).tables, body.schema, body.table);

    if (PROTECTED_TABLES.has(table.name)) {
      throw new RequestError(
        400,
        `${describe(table)} records what has already been applied, so this interface adds no row to it.`,
      );
    }

    const statement = insertRow(table, body);
    const result = await pool.query<Record<string, unknown>>(statement.text, statement.values);


    return json({ inserted: result.rows[0] ?? null });
  }

  /** Changing or removing one row, addressed by its whole primary key. */
  async function change(
    request: Request,
    database: string,
    action: 'update' | 'delete',
  ): Promise<Response> {
    const body = await readBody(request);
    const pool = await pools.of(database);
    const table = findTable((await readCatalogue(pool)).tables, body.schema, body.table);

    const statement = action === 'update' ? updateRow(table, body) : deleteRow(table, body);
    const result = await pool.query(statement.text, statement.values);
    const affected = result.rowCount ?? 0;


    if (affected === 0) {
      return json(
        { error: 'no-such-row', message: 'No row has that key any more; the table may have changed.' },
        409,
      );
    }

    return json({ [action === 'update' ? 'updated' : 'deleted']: affected });
  }

  /**
   * Adding, renaming or dropping one column.
   *
   * Adding is open: a nullable column nothing reads cannot break a module. Renaming and dropping are
   * allowed only on a column this interface added, because the rest belong to a module's migrations and
   * its code reads them by name — a rename would take the module down with the next request. Which is
   * which comes from the journal; `information_schema` does not record who created a column.
   */
  async function reshape(
    request: Request,
    database: string,
    action: ChangeKind,
  ): Promise<Response> {
    const body = await readBody(request);
    const pool = await pools.of(database);
    const table = checkReshapable(
      findTable((await readCatalogue(pool)).tables, body.schema, body.table),
    );

    if (action === 'add') {
      const column = checkName(body.column);
      const sql = addColumn(table, column, {
        type: body.type,
        required: body.required,
        default: body.default,
      });

      const version = await applyChange(pool, {
        kind: 'add',
        schema: table.schema,
        table: table.name,
        column,
        // The journal keeps what was asked for; `sql` beside it keeps what was done.
        details: {
          type: body.type,
          ...(body.required === true ? { required: true } : {}),
          ...(body.default === undefined || body.default === null || body.default === ''
            ? {}
            : { default: body.default }),
        },
        sql,
      });

      return json({ added: column, version });
    }

    const column = findColumn(table, body.column).name;
    const owned = ownColumns(await readJournal(pool));

    if (!owned.has(`${table.schema}.${table.name}.${column}`)) {
      throw new RequestError(
        400,
        `Column ${column} of ${describe(table)} belongs to this project's migrations, ` +
          'so this interface will not rename or drop it — the code that reads it would stop working.',
      );
    }

    if (action === 'rename') {
      const to = checkName(body.to);
      const sql = renameColumn(table, column, to);

      const version = await applyChange(pool, {
        kind: 'rename',
        schema: table.schema,
        table: table.name,
        column,
        details: { to },
        sql,
      });

      return json({ renamed: to, version });
    }

    const sql = dropColumn(table, column);
    const version = await applyChange(pool, {
      kind: 'drop',
      schema: table.schema,
      table: table.name,
      column,
      details: {},
      sql,
    });

    return json({ dropped: column, version });
  }

  /** The body of a changing or querying request, once the header guard has passed. */
  async function readBody(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get(REQUEST_HEADER) !== REQUEST_HEADER_VALUE) {
      throw new RequestError(
        403,
        `A request to this interface must carry ${REQUEST_HEADER}: ${REQUEST_HEADER_VALUE}.`,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new RequestError(400, 'The body is JSON.');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RequestError(400, 'The body is a JSON object.');
    }

    return body as Record<string, unknown>;
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        if (error instanceof RequestError) {
          return json({ error: 'refused', message: error.message }, error.status);
        }

        if (error instanceof UnknownDatabase) {
          return json({ error: 'not-found', message: error.message }, 404);
        }

        /*
         * Anything else is PostgreSQL, and its message says what went wrong — a column that does not
         * exist any more, a value of the wrong type. It does not carry the row, so it is safe to show.
         * What it does not say is whose fault it is, and that decides the status.
         */
        const message = error instanceof Error ? error.message : String(error);
        const code = pgCode(error);

        /*
         * A value the request carried, refused by the column that would hold it, is the caller's
         * mistake and not a failure here: `1abc` in a filter on a uuid column answered 500 and read as
         * "the interface is broken". Classes 22 and 23 are exactly that case — a value the type cannot
         * take, and a value the table's own constraints reject.
         */
        if (INPUT_CLASSES.has(code.slice(0, 2))) {
          return json({ error: 'refused', message }, 400);
        }

        /*
         * A database that is not there yet, which is not the same as one this interface was never
         * given: that one is `not-found` above. Modules create their own database on the first request
         * that needs it, so this is the ordinary state of a module nobody has reached, and answering
         * 500 read as "the interface is broken".
         */
        if (code === ABSENT_DATABASE) {
          return json({ error: 'database-absent', message }, 404);
        }

        // Everything left is this side failing: unreachable, out of connections, a broken pool.

        return json({ error: 'database-failed', message }, 500);
      }
    },
    end: pools.end,
  };
}

function describe(table: Table): string {
  return `${table.schema}.${table.name}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function methodNotAllowed(): Response {
  return json({ error: 'method-not-allowed', message: 'That path does not take this method.' }, 405);
}

