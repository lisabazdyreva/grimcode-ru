import { describe, expect, it } from 'vitest';

import type { Queryable } from './catalog.js';
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

/** A pool that answers the catalogue and remembers what else it was asked. */
function fakePool(tables: Table[]): Queryable & { asked: { text: string; values: unknown[] }[] } {
  const asked: { text: string; values: unknown[] }[] = [];

  return {
    asked,
    async query<Row>(text: string, values: unknown[] = []) {
      asked.push({ text, values });

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

      // The planner knows about one table and not the other, which is the case that used to read as zero.
      if (text.includes('pg_class')) {
        const known = values[1] === 'identities';
        return { rows: [{ estimate: known ? '42' : '-1' }] as Row[], rowCount: 1 };
      }
      if (text.includes('capped')) return { rows: [{ total: '3' }] as Row[], rowCount: 1 };
      if (text.includes('count(*)')) return { rows: [{ total: '7' }] as Row[], rowCount: 1 };
      if (text.startsWith('SELECT')) return { rows: [{ id: 'u-1' }] as Row[], rowCount: 1 };

      return { rows: [] as Row[], rowCount: 1 };
    },
  };
}

function build(tables: Table[] = [rows, grants]) {
  const pool = fakePool(tables);
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
      tables: { name: string; primaryKey: string[]; rows: { count: number; approximate: boolean } }[];
    };

    expect(body.tables.map((table) => table.name)).toEqual(['identities', 'administrator_grants']);
    expect(body.tables[1]?.primaryKey).toEqual(['administrator_id', 'service']);
    expect(body.tables[0]?.rows).toEqual({ count: 42, approximate: true });
  });

  /**
   * `reltuples` is -1 until something analyses the table, and reading that as zero told a person that a
   * table with rows in it was empty. So a table the planner knows nothing about is counted instead.
   */
  it('counts a table the planner has no estimate for', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; rows: { count: number; approximate: boolean } }[];
    };

    expect(body.tables[1]?.rows).toEqual({ count: 3, approximate: false });
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
