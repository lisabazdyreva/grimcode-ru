import pg from 'pg';

import type { Queryable } from './catalog.js';

/** One database this interface may look at, as the program that builds it names them. */
export interface DatabaseSource {
  /** What a person sees and what the API addresses it by. */
  name: string;
  connectionString: string;
}

export interface PoolLog {
  (event: { level: 'info' | 'error'; message: string; database?: string; error?: string }): void;
}

/**
 * Connections of this interface's own, never the application's.
 *
 * This is the decision the whole package rests on. Borrowing a module's pool would be cheaper by a
 * handful of connections and would tie the console to the site: a heavy query typed in here would
 * hold connections a request needs, a transaction left open would hold a lock on a live table, and
 * session state — a `SET`, a temporary table — would go back into the pool and reach the next
 * request that borrowed that connection.
 *
 * So: separate pools, small, and opened only when someone actually looks at a database.
 */
const MAX_CONNECTIONS = 2;

export interface Pools {
  /** The pool for one database, opened on the first request that needs it. */
  of(name: string): Promise<Queryable>;
  names(): string[];
  /** Closes what was opened. For a test, and for a program that wants to stop cleanly. */
  end(): Promise<void>;
}

/**
 * How a database is opened. The real one is below; a test hands in its own, which is the only reason
 * this is an argument — every other way of testing this package would need a live server.
 */
export type Connect = (source: DatabaseSource, log: PoolLog) => Promise<Queryable>;

export function createPools(
  databases: DatabaseSource[],
  log: PoolLog,
  connect: Connect = openPool,
): Pools {
  const sources = new Map(databases.map((database) => [database.name, database]));

  /*
   * The promise is remembered, not the pool: two requests arriving together would both find nothing
   * remembered and both open a pool, and the second one would never be closed. Storing the promise
   * makes the second request wait for the first one's pool.
   */
  const opened = new Map<string, Promise<Queryable>>();

  return {
    async of(name) {
      const source = sources.get(name);
      if (!source) throw new UnknownDatabase(name);

      const existing = opened.get(name);
      if (existing) return existing;

      const pool = connect(source, log);
      opened.set(name, pool);
      return pool;
    },

    names() {
      return [...sources.keys()];
    },

    async end() {
      const pools = [...opened.values()];
      opened.clear();

      await Promise.all(
        pools.map(async (pending) => {
          const pool = await pending;
          if (closeable(pool)) await pool.end().catch(() => undefined);
        }),
      );
    },
  };
}

function closeable(pool: Queryable): pool is Queryable & { end(): Promise<void> } {
  return typeof (pool as { end?: unknown }).end === 'function';
}

/**
 * PostgreSQL types this package reads as written rather than as moments in time.
 *
 * The driver turns `date` and `timestamp` into a JavaScript `Date`, which is a point on the timeline —
 * and neither of those types is one. On a machine three hours east of UTC the date `2026-08-27` came
 * back as `2026-08-26T21:00:00.000Z`: the screen showed the day before the one stored. A `timestamp`
 * without a zone was read as local and shifted by the same offset, so 10:00 became 07:00Z.
 *
 * Both are handed over as the text PostgreSQL sent. `timestamptz` is left alone: that one really is a
 * moment, and a `Date` is the right shape for it.
 */
const READ_AS_WRITTEN = new Set([
  1082, // date
  1114, // timestamp without time zone
]);

export function typeParsers(): { getTypeParser: (oid: number, format?: unknown) => unknown } {
  return {
    getTypeParser(oid, format) {
      if (READ_AS_WRITTEN.has(oid)) return (value: string) => value;
      return pg.types.getTypeParser(oid, format as never);
    },
  };
}

async function openPool(source: DatabaseSource, log: PoolLog): Promise<Queryable> {
  const pool = new pg.Pool({
    connectionString: source.connectionString,
    types: typeParsers(),
    max: MAX_CONNECTIONS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // What `pg_stat_activity` shows, and the reason a heavy query here can be told from the site's.
    application_name: 'pg-interface',
  });

  // Without this listener a connection that breaks while idle takes the whole process down, and this
  // package runs inside the application's process.
  pool.on('error', (error) => {
    log({
      level: 'error',
      message: 'idle connection failed',
      database: source.name,
      error: error.message,
    });
  });

  log({ level: 'info', message: 'database opened', database: source.name });
  return pool;
}

export class UnknownDatabase extends Error {
  constructor(readonly database: string) {
    super(`No database named ${database} was given to this interface.`);
    this.name = 'UnknownDatabase';
  }
}
