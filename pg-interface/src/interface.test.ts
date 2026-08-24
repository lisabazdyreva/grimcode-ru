import { describe, expect, it } from 'vitest';

import { COUNT_LIMIT, type Queryable, type RowCount } from './catalog.js';
import { JOURNAL_TABLE } from './changes.js';
import { conditionsFor } from './filters.js';
import { RequestError, type Table } from './identifiers.js';
import {
  createDatabaseInterface,
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
} from './index.js';
import { deleteRow, pageOf, selectRows, updateRow } from './statements.js';
import { serveScreen } from './static.js';

/** A table with a single-column key, and one with a key of two — both shapes exist in this project. */
const rows: Table = {
  schema: 'public',
  name: 'identities',
  columns: [
    { name: 'id', type: 'uuid', nullable: false },
    { name: 'email', type: 'character varying', nullable: false },
    { name: 'created_at', type: 'timestamp with time zone', nullable: false },
    { name: 'attempts', type: 'integer', nullable: true },
  ],
  primaryKey: ['id'],
};

const grants: Table = {
  schema: 'public',
  name: 'administrator_grants',
  columns: [
    { name: 'administrator_id', type: 'uuid', nullable: false },
    { name: 'service', type: 'character varying', nullable: false },
    { name: 'note', type: 'text', nullable: true },
  ],
  primaryKey: ['administrator_id', 'service'],
};

/** A table the planner has an estimate for, small enough that the estimate is not used. */
const sessions: Table = {
  schema: 'public',
  name: 'sessions',
  columns: [
    { name: 'id', type: 'uuid', nullable: false },
    { name: 'expires_at', type: 'timestamp with time zone', nullable: false },
  ],
  primaryKey: ['id'],
};

/** A table with no estimate that turns out to hold more rows than the count is willing to read. */
const audit: Table = {
  schema: 'public',
  name: 'auth_audit',
  columns: [{ name: 'id', type: 'uuid', nullable: false }],
  primaryKey: ['id'],
};

/**
 * What the planner says about each table. `identities` is above `COUNT_LIMIT`, so its number is the
 * estimate; the rest are counted, whether the planner has a small estimate or none at all.
 */
const ESTIMATES: Record<string, string> = {
  identities: String(COUNT_LIMIT + 40_000),
  sessions: '3',
  administrator_grants: '-1',
  auth_audit: '-1',
};

/** A value no uuid column can hold, which the fake pool refuses the way PostgreSQL would. */
const UNHOLDABLE = 'нет';

/** A value that makes the fake pool fail the way an unreachable database does: no code of its own. */
const UNREACHABLE = 'обрыв';

/** What counting returns for each table, once the estimate has sent it to be counted. */
const COUNTS: Record<string, string> = {
  sessions: '3',
  administrator_grants: '3',
  auth_audit: String(COUNT_LIMIT + 1),
};

describe('what a request may name', () => {
  it('refuses a column the table does not have', () => {
    expect(() => selectRows(rows, { order: [{ column: 'passwd', direction: 'asc' }] })).toThrow(
      /No column passwd/,
    );
  });

  it('refuses a direction that is not asc or desc', () => {
    expect(() =>
      selectRows(rows, { order: [{ column: 'email', direction: 'asc; DROP TABLE identities' }] }),
    ).toThrow(/asc/);
  });

  it('offers text conditions for text and comparison conditions for numbers', () => {
    expect(conditionsFor('character varying')).toContain('contains');
    expect(conditionsFor('integer')).not.toContain('contains');
    expect(conditionsFor('integer')).toContain('greater-than');
  });

  it('refuses a condition that does not apply to the column', () => {
    expect(() =>
      selectRows(rows, { filters: [{ column: 'attempts', condition: 'contains', value: '1' }] }),
    ).toThrow(/does not apply/);
  });
});

describe('values never become SQL', () => {
  it('puts every filter value in a parameter', () => {
    const { rows: statement } = selectRows(rows, {
      filters: [
        { column: 'email', condition: 'contains', value: "o'brien" },
        { column: 'attempts', condition: 'greater-than', value: 3 },
      ],
      combine: 'and',
    });

    expect(statement.text).not.toContain("o'brien");
    expect(statement.values).toContain('%o\'brien%');
    expect(statement.values).toContain(3);
    expect(statement.text).toMatch(/ILIKE \$1 AND "attempts" > \$2/);
  });

  it('treats a wildcard the person typed as text, not as a pattern', () => {
    const { rows: statement } = selectRows(rows, {
      filters: [{ column: 'email', condition: 'starts-with', value: '50%_x' }],
    });

    expect(statement.values[0]).toBe('50\\%\\_x%');
  });

  it('parameterises the page as well, so a limit cannot carry SQL', () => {
    const { rows: statement } = selectRows(rows, { limit: 10, offset: 20 });
    expect(statement.text).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(statement.values).toEqual([10, 20]);
  });

  it('clamps the page instead of trusting it', () => {
    expect(pageOf({ limit: 100_000 }).limit).toBe(500);
    expect(pageOf({ limit: 0 }).limit).toBe(1);
    expect(pageOf({ offset: -5 }).offset).toBe(0);
    expect(() => pageOf({ limit: '10' })).toThrow(RequestError);
  });

  it('counts with its own parameters, so an empty page still knows the total', () => {
    const { total } = selectRows(rows, {
      filters: [{ column: 'email', condition: 'is', value: 'a@b.c' }],
      offset: 1000,
    });

    expect(total.text).toMatch(/count\(\*\)/);
    expect(total.values).toEqual(['a@b.c']);
  });
});

describe('a row is addressed by its whole key', () => {
  it('changes one row of a single-column key', () => {
    const statement = updateRow(rows, { key: { id: 'u-1' }, values: { email: 'new@example.test' } });

    expect(statement.text).toBe('UPDATE "public"."identities" SET "email" = $1 WHERE "id" = $2');
    expect(statement.values).toEqual(['new@example.test', 'u-1']);
  });

  it('needs both columns of a two-column key', () => {
    expect(() =>
      updateRow(grants, { key: { administrator_id: 'a-1' }, values: { note: 'hi' } }),
    ).toThrow(/administrator_id, service/);

    const statement = updateRow(grants, {
      key: { administrator_id: 'a-1', service: 'auth' },
      values: { note: 'hi' },
    });
    expect(statement.text).toMatch(/WHERE "administrator_id" = \$2 AND "service" = \$3/);
  });

  it('refuses a key that names something outside the key', () => {
    expect(() => deleteRow(rows, { key: { id: 'u-1', email: 'a@b.c' } })).toThrow(/key of/);
  });

  it('refuses to change a key column', () => {
    expect(() => updateRow(rows, { key: { id: 'u-1' }, values: { id: 'u-2' } })).toThrow(
      /identifies the row/,
    );
  });

  it('refuses a table with no key at all', () => {
    const keyless: Table = { ...rows, primaryKey: [] };
    expect(() => deleteRow(keyless, { key: {} })).toThrow(/no primary key/);
  });
});

interface JournalEntry {
  version: number;
  kind: string;
  schema: string;
  table: string;
  column: string;
  details: Record<string, unknown>;
  sql: string;
  applied_at: string | null;
}

/**
 * A pool that answers the catalogue, keeps a journal, and applies `ALTER TABLE` to its own tables.
 *
 * It has to do that last part: a test that only checked the statement text would not notice that the
 * journal and the catalogue disagree about what a column is called after a rename.
 */
type FakePool = Queryable & {
  asked: { text: string; values: unknown[] }[];
  journal: JournalEntry[];
  connect(): Promise<Queryable & { release(): void }>;
  failOnAlter?: boolean;
};

function fakePool(tables: Table[]): FakePool {
  const asked: { text: string; values: unknown[] }[] = [];
  const journal: JournalEntry[] = [];

  /** `ALTER TABLE` as this fake understands it — the three shapes `ddl.ts` can produce. */
  function reshape(text: string): void {
    const add = /^ALTER TABLE "(.+)"\."(.+)" ADD COLUMN "(.+)" (\w+)$/.exec(text);
    const rename = /^ALTER TABLE "(.+)"\."(.+)" RENAME COLUMN "(.+)" TO "(.+)"$/.exec(text);
    const drop = /^ALTER TABLE "(.+)"\."(.+)" DROP COLUMN "(.+)"$/.exec(text);

    const found = (schema: string, name: string) =>
      tables.find((table) => table.schema === schema && table.name === name);

    if (add) {
      found(add[1] ?? '', add[2] ?? '')?.columns.push({
        name: add[3] ?? '',
        type: add[4] ?? '',
        nullable: true,
      });
      return;
    }

    if (rename) {
      const column = found(rename[1] ?? '', rename[2] ?? '')?.columns.find(
        (entry) => entry.name === rename[3],
      );
      if (column) column.name = rename[4] ?? column.name;
      return;
    }

    if (drop) {
      const table = found(drop[1] ?? '', drop[2] ?? '');
      if (table) table.columns = table.columns.filter((entry) => entry.name !== drop[3]);
    }
  }

  const pool: FakePool = {
    asked,
    journal,
    async connect() {
      return { query: (text: string, values?: unknown[]) => pool.query(text, values), release() {} };
    },
    async query<Row>(text: string, values: unknown[] = []) {
      asked.push({ text, values });

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] as Row[], rowCount: 0 };

      if (text.includes(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE}`)) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (text.includes('MAX(version)')) {
        return { rows: [{ next: journal.length + 1 }] as Row[], rowCount: 1 };
      }
      if (text.includes(`FROM ${JOURNAL_TABLE}`)) {
        return { rows: journal as Row[], rowCount: journal.length };
      }
      if (text.includes(`INSERT INTO ${JOURNAL_TABLE}`)) {
        journal.push({
          version: Number(values[0]),
          kind: String(values[1]),
          schema: String(values[2]),
          table: String(values[3]),
          column: String(values[4]),
          details: JSON.parse(String(values[5])) as Record<string, unknown>,
          sql: String(values[6]),
          applied_at: null,
        });
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (text.includes(`UPDATE ${JOURNAL_TABLE}`)) {
        const entry = journal.find((row) => row.version === Number(values[0]));
        if (entry) entry.applied_at = '2026-08-24T00:00:00.000Z';
        return { rows: [] as Row[], rowCount: 1 };
      }

      if (text.startsWith('ALTER TABLE')) {
        if (pool.failOnAlter) throw Object.assign(new Error('permission denied'), { code: '42501' });
        reshape(text);
        return { rows: [] as Row[], rowCount: 0 };
      }

      if (text.includes('information_schema.columns')) {
        const rows = tables.flatMap((table) =>
          table.columns.map((column) => ({
            table_schema: table.schema,
            table_name: table.name,
            column_name: column.name,
            data_type: column.type,
            is_nullable: column.nullable ? 'YES' : 'NO',
          })),
        );
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('table_constraints')) {
        const rows = tables.flatMap((table) =>
          table.primaryKey.map((column, index) => ({
            table_schema: table.schema,
            table_name: table.name,
            column_name: column,
            position: index + 1,
          })),
        );
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('pg_class')) {
        const estimate = ESTIMATES[String(values[1])] ?? '-1';
        return { rows: [{ estimate }] as Row[], rowCount: 1 };
      }
      // The counting query names its table in the text, not in a parameter — that is how it is found here.
      if (text.includes('capped')) {
        const named = Object.keys(COUNTS).find((name) => text.includes(`"${name}"`));
        return { rows: [{ total: COUNTS[named ?? ''] ?? '3' }] as Row[], rowCount: 1 };
      }
      if (text.includes('count(*)')) return { rows: [{ total: '7' }] as Row[], rowCount: 1 };

      // What PostgreSQL does with a value the column cannot hold: refuses, with a code in class 22.
      if (values.includes(UNHOLDABLE)) {
        throw Object.assign(new Error('invalid input syntax for type uuid: "нет"'), { code: '22P02' });
      }
      // And what a database that is simply not there does, which is not the caller's fault at all.
      if (values.includes(UNREACHABLE)) {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' });
      }
      if (text.startsWith('SELECT')) return { rows: [{ id: 'u-1' }] as Row[], rowCount: 1 };

      return { rows: [] as Row[], rowCount: 1 };
    },
  };

  return pool;
}

function build(tables: Table[] = [rows, grants, sessions, audit]) {
  // Cloned: the fake applies `ALTER TABLE` to these objects, and a column added by one test would
  // otherwise still be there in the next one.
  const pool = fakePool(structuredClone(tables));
  const logged: string[] = [];

  const api = createDatabaseInterface({
    databases: [{ name: 'demo_auth', connectionString: 'postgres://unused/demo_auth' }],
    basePath: '/admin/embed/database',
    log: (event) => logged.push(event.message),
    connect: async () => pool,
  });

  return { api, pool, logged };
}

const at = (path: string, init?: RequestInit) =>
  new Request(`http://panel.test/admin/embed/database${path}`, init);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  at(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const marked = { [REQUEST_HEADER]: REQUEST_HEADER_VALUE };

describe('the API', () => {
  it('lists the databases it was handed and nothing else', async () => {
    const { api } = build();
    const response = await api.fetch(at('/api/databases'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ databases: [{ name: 'demo_auth' }] });
  });

  it('refuses a database it was not handed', async () => {
    const { api } = build();
    expect((await api.fetch(at('/api/databases/other/tables'))).status).toBe(404);
  });

  it('describes tables with their key and the conditions each column takes', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; primaryKey: string[]; rows: RowCount }[];
    };

    expect(body.tables.map((table) => table.name)).toEqual([
      'identities',
      'administrator_grants',
      'sessions',
      'auth_audit',
    ]);
    expect(body.tables[1]?.primaryKey).toEqual(['administrator_id', 'service']);
    expect(body.tables[0]?.rows).toEqual({ count: COUNT_LIMIT + 40_000, kind: 'estimate' });
  });

  /**
   * The estimate decides whether counting is cheap, and nothing else. A table nothing has analysed says
   * `-1`, a small table says a small number, and both are counted — otherwise `~3` sat beside a plain
   * `5` and the difference between them was only autovacuum.
   */
  it('counts every table small enough to count, estimate or not', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; rows: RowCount }[];
    };

    expect(body.tables[1]?.rows).toEqual({ count: 3, kind: 'exact' });
    expect(body.tables[2]?.rows).toEqual({ count: 3, kind: 'exact' });
  });

  /**
   * Counting stops at the limit, and what comes back is a floor rather than an estimate — the screen
   * says `>10000`, not `~10000`. The two are different statements and used to share one sign.
   */
  it('stops counting a table larger than the limit and says so', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; rows: RowCount }[];
    };

    expect(body.tables[3]?.rows).toEqual({ count: COUNT_LIMIT, kind: 'more' });
  });

  it('reads a page of rows with the total beside it', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows', { schema: 'public', table: 'identities' }, marked),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ id: 'u-1' }], total: 7 });
  });

  /**
   * The guard this package has to hold itself: the repository's mechanical CSRF check reads tRPC
   * procedures, and this is not one.
   */
  it('refuses a changing request that could have come from another site', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows/delete', { schema: 'public', table: 'identities', key: { id: 'u-1' } }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(REQUEST_HEADER);
  });

  it('changes a row when the request carries the header', async () => {
    const { api, pool } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows/update',
        { schema: 'public', table: 'identities', key: { id: 'u-1' }, values: { email: 'x@y.z' } },
        marked,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 1 });
    expect(pool.asked.at(-1)?.text).toMatch(/^UPDATE/);
  });

  /**
   * A value the column cannot hold is the caller's mistake, so it reads as a refusal rather than as
   * this interface breaking. It used to answer 500, which on screen looked like the section was broken —
   * and the filter panel produced one the moment it opened on a uuid column.
   */
  it('answers a value the column cannot hold as a refusal, not a failure', async () => {
    const { api, logged } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows',
        {
          schema: 'public',
          table: 'identities',
          filters: [{ column: 'id', condition: 'is', value: UNHOLDABLE }],
        },
        marked,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'refused' });

    // The code says what happened; the value that caused it is not written down.
    expect(logged.join(' ')).toContain('22P02');
    expect(logged.join(' ')).not.toContain(UNHOLDABLE);
  });

  /** The other side of the same fork: a database that is not answering is still this side's failure. */
  it('still answers a database that fails as a failure', async () => {
    const { api } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows',
        {
          schema: 'public',
          table: 'identities',
          filters: [{ column: 'id', condition: 'is', value: UNREACHABLE }],
        },
        marked,
      ),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'database-failed' });
  });

  it('refuses a table the database does not have', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows', { schema: 'public', table: 'secrets' }, marked),
    );

    expect(response.status).toBe(404);
  });

  it('serves the screen at its root', async () => {
    const { api } = build();
    const response = await api.fetch(at('/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app">');
  });

  it('serves a built asset, and lets it be cached', async () => {
    const { api } = build();
    const page = await (await api.fetch(at('/'))).text();
    const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(page)?.[1];
    expect(asset).toBeDefined();

    const response = await api.fetch(at(`/${asset}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  /**
   * The guard is tested on `serveScreen` itself rather than through a request, and that is the point:
   * `new Request(…)` collapses `..` in a URL before this package ever sees it, so a test that went in
   * over HTTP would pass without the guard existing at all. What is checked here is the function that
   * would read the file.
   */
  it('refuses a path that walks out of the built screen', async () => {
    // Two levels up from `web/dist` is this package's own manifest — a file that certainly exists, which
    // is what makes this a probe rather than a path that happens to resolve to nothing.
    const response = await serveScreen('/../../package.json');

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).not.toContain('@grimcode/pg-interface');
  });

  it('answers a method a path does not take', async () => {
    const { api } = build();
    expect((await api.fetch(at('/api/databases/demo_auth/tables', { method: 'POST' }))).status).toBe(
      405,
    );
    expect((await api.fetch(at('/', { method: 'POST' }))).status).toBe(405);
  });

  it('keeps row values out of the log', async () => {
    const { api, logged } = build();
    await api.fetch(
      post(
        '/api/databases/demo_auth/rows',
        {
          schema: 'public',
          table: 'identities',
          filters: [{ column: 'email', condition: 'is', value: 'secret@example.test' }],
        },
        marked,
      ),
    );

    expect(logged.join(' ')).not.toContain('secret@example.test');
    expect(logged.join(' ')).toContain('public.identities');
  });
});

/**
 * Columns: what this interface may do to the shape of a table, and what it may not.
 *
 * The rule the whole group is about: **adding is open, renaming and dropping are not.** A nullable
 * column nobody reads cannot break a module; a renamed column its code reads breaks it with the next
 * request. Which columns are which is not in `information_schema` — it is in this package's journal.
 */
describe('the shape of a table', () => {
  const addColumnAt = (column: string, type: string, table = 'identities') =>
    post('/api/databases/demo_auth/columns', { schema: 'public', table, column, type }, marked);

  it('adds a nullable column and remembers that it added it', async () => {
    const { api, pool } = build();
    const response = await api.fetch(addColumnAt('nickname', 'text'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 'nickname', version: 1 });

    // The statement, once, and always nullable: `NOT NULL` would break the module's own INSERT.
    const altered = pool.asked.filter((query) => query.text.startsWith('ALTER TABLE'));
    expect(altered).toHaveLength(1);
    expect(altered[0]?.text).toBe('ALTER TABLE "public"."identities" ADD COLUMN "nickname" text');

    // Recorded as applied, with the statement kept beside it.
    expect(pool.journal).toHaveLength(1);
    expect(pool.journal[0]).toMatchObject({ kind: 'add', column: 'nickname', applied_at: expect.any(String) });
  });

  it('marks its own columns as its own, and the rest as not', async () => {
    const { api } = build();
    await api.fetch(addColumnAt('nickname', 'text'));

    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; columns: { name: string; own: boolean }[] }[];
    };
    const identities = body.tables.find((table) => table.name === 'identities');

    expect(identities?.columns.find((column) => column.name === 'nickname')?.own).toBe(true);
    expect(identities?.columns.find((column) => column.name === 'email')?.own).toBe(false);
  });

  /** The test this whole feature stands on. A column of a migration is the module's, not ours. */
  it('refuses to rename or drop a column that came from a migration', async () => {
    const { api } = build();

    const renamed = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/rename',
        { schema: 'public', table: 'identities', column: 'email', to: 'mail' },
        marked,
      ),
    );
    const dropped = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/drop',
        { schema: 'public', table: 'identities', column: 'email' },
        marked,
      ),
    );

    expect(renamed.status).toBe(400);
    expect(await renamed.text()).toContain('migrations');
    expect(dropped.status).toBe(400);
  });

  it('renames and drops a column it added, and the journal follows the new name', async () => {
    const { api, pool } = build();
    await api.fetch(addColumnAt('nickname', 'text'));

    const renamed = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/rename',
        { schema: 'public', table: 'identities', column: 'nickname', to: 'handle' },
        marked,
      ),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ renamed: 'handle' });

    // Renaming keeps it ours: otherwise the next rename would be refused as a migration's column.
    const listed = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; columns: { name: string; own: boolean }[] }[];
    };
    const columns = listed.tables.find((table) => table.name === 'identities')?.columns ?? [];
    expect(columns.find((column) => column.name === 'handle')?.own).toBe(true);
    expect(columns.some((column) => column.name === 'nickname')).toBe(false);

    const dropped = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/drop',
        { schema: 'public', table: 'identities', column: 'handle' },
        marked,
      ),
    );
    expect(dropped.status).toBe(200);
    expect(pool.journal.map((entry) => entry.kind)).toEqual(['add', 'rename', 'drop']);
  });

  it('refuses a name that would be a nuisance, and a type it does not offer', async () => {
    const { api } = build();

    expect((await api.fetch(addColumnAt('two words', 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('пробел', 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('a'.repeat(64), 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('ok_name', 'money'))).status).toBe(400);
    // A name the table already has, which PostgreSQL would refuse anyway — but with its own message.
    expect((await api.fetch(addColumnAt('email', 'text'))).status).toBe(400);
  });

  it('will not reshape the tables that record what has been applied', async () => {
    const { api } = build([{ ...rows, name: JOURNAL_TABLE }, { ...rows, name: 'schema_migrations' }]);

    expect((await api.fetch(addColumnAt('note', 'text', JOURNAL_TABLE))).status).toBe(400);
    expect((await api.fetch(addColumnAt('note', 'text', 'schema_migrations'))).status).toBe(400);
  });

  it('needs the header for a change of shape, like any other change', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/columns', {
        schema: 'public',
        table: 'identities',
        column: 'nickname',
        type: 'text',
      }),
    );

    expect(response.status).toBe(403);
  });

  /** Applied and recorded are one transaction, so a statement that fails leaves no record behind. */
  it('rolls back the record when the statement fails', async () => {
    const { api, pool } = build();
    pool.failOnAlter = true;

    const response = await api.fetch(addColumnAt('nickname', 'text'));

    expect(response.status).toBe(500);
    expect(pool.asked.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.journal.every((entry) => entry.applied_at === null)).toBe(true);
  });
});
