import { estimateRows, readCatalogue } from './catalog.js';
import { conditionsFor } from './filters.js';
import { findTable, RequestError, type Table } from './identifiers.js';
import {
  createPools,
  UnknownDatabase,
  type Connect,
  type DatabaseSource,
  type PoolLog,
} from './pools.js';
import { deleteRow, selectRows, updateRow } from './statements.js';
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
 * Two rules the package keeps for itself, because nothing outside it can:
 *
 * - **identifiers are looked up, values are parameters.** See `identifiers.ts`;
 * - **row values never reach the log.** These databases hold password hashes and session
 *   identifiers, and a log is a place things are kept and forwarded.
 */
export interface DatabaseInterfaceOptions {
  databases: DatabaseSource[];
  /** Where this interface is mounted, so it can tell its own paths from the rest of the URL. */
  basePath: string;
  log?: PoolLog;
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

export function createDatabaseInterface(options: DatabaseInterfaceOptions): DatabaseInterface {
  const log: PoolLog = options.log ?? (() => undefined);
  const pools = createPools(options.databases, log, options.connect);
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
      if (action !== 'update' && action !== 'delete') {
        return json({ error: 'not-found', message: `Unknown action "${action}".` }, 404);
      }
      return await change(request, decodeURIComponent(segments[2] ?? ''), action);
    }

    return json({ error: 'not-found', message: 'No such path in this interface.' }, 404);
  }

  /** The tables of one database, with the key each row is addressed by and a rough size. */
  async function tables(database: string): Promise<Response> {
    const pool = await pools.of(database);
    const { tables: found } = await readCatalogue(pool);

    const described = await Promise.all(
      found.map(async (table) => ({
        schema: table.schema,
        name: table.name,
        primaryKey: table.primaryKey,
        estimatedRows: await estimateRows(pool, table),
        columns: table.columns.map((column) => ({
          ...column,
          conditions: conditionsFor(column.type),
        })),
      })),
    );

    log({ level: 'info', message: 'tables listed', database });
    return json({ tables: described });
  }

  /** One page of rows, and how many rows the same filters match. */
  async function rows(request: Request, database: string): Promise<Response> {
    const body = await readBody(request);
    const pool = await pools.of(database);
    const table = findTable((await readCatalogue(pool)).tables, body.schema, body.table);

    const { rows: rowsStatement, total: totalStatement } = selectRows(table, body);
    const [page, counted] = await Promise.all([
      pool.query<Record<string, unknown>>(rowsStatement.text, rowsStatement.values),
      pool.query<{ total: string }>(totalStatement.text, totalStatement.values),
    ]);

    // Counts and names, never a value: what is in these rows is what a log must not keep.
    log({ level: 'info', message: `read ${page.rows.length} rows from ${describe(table)}`, database });

    return json({
      columns: table.columns,
      primaryKey: table.primaryKey,
      rows: page.rows,
      total: Number(counted.rows[0]?.total ?? 0),
    });
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

    log({ level: 'info', message: `${action}d ${affected} row in ${describe(table)}`, database });

    if (affected === 0) {
      return json(
        { error: 'no-such-row', message: 'No row has that key any more; the table may have changed.' },
        409,
      );
    }

    return json({ [action === 'update' ? 'updated' : 'deleted']: affected });
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
         * Anything else is PostgreSQL refusing, or being unreachable. Its message says what went
         * wrong — a column that does not exist any more, a value of the wrong type — and it does not
         * carry the row, so it is safe both to log and to show.
         */
        const message = error instanceof Error ? error.message : String(error);
        log({ level: 'error', message: `request failed: ${message}` });
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

