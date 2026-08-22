# @grimcode/pg-interface

A database interface for PostgreSQL: the tables of a database, a page of rows with filters and
sorting, and changing or removing one row.

It replaced the third-party console this project used to embed in its admin panel. What it does not
do is decide who may use it — whoever mounts it decides that, which is what lets it live inside an
application that already knows who is asking.

## Nothing of this repository is imported here

Not a style: this package is meant to be publishable on its own, and one import of a workspace
package would tie it to the repository forever. `check-boundaries.mjs` refuses one — the rule is
`{ area: 'pg-interface', mayUse: [] }` in `scripts/workspace-rules.mjs`.

Everything arrives as an argument:

```ts
const database = createDatabaseInterface({
  basePath: '/admin/embed/database',
  databases: [{ name: 'app_auth', connectionString: 'postgres://…/app_auth' }],
  log: (event) => logger[event.level](event.message, { database: event.database }),
});

const response = await database.fetch(request);
```

`basePath` is where it is mounted, so it can tell its own paths from the rest of the URL. `fetch` is
the whole surface: a `Request` in, a `Response` out, which is what lets a router treat it as it
treats a module.

## Its own connections, and few of them

Two per database, opened on the first request that looks at one. Borrowing the application's pool
would be cheaper and would tie the console to the site: a heavy query typed in here would hold
connections a request needs, a transaction left open would hold a lock on a live table, and session
state — a `SET`, a temporary table — would return to the pool and reach whatever borrowed that
connection next.

`application_name` is `pg-interface`, so a query of this interface can be told from the application's
in `pg_stat_activity`.

## What keeps it from being a hole

The console it replaced was safe in a way this one cannot be: there, a person wrote the SQL and owned
it. Here the query is assembled from a request body, so four rules do that work instead.

**Identifiers are looked up, values are parameters.** Every table and column named by a request is
found in `information_schema` first; nothing else is ever interpolated. A value carrying `'; DROP
TABLE …` is a string that matches nothing — checked against a live database, not only in a test.

**Conditions are a closed list.** Text columns take `contains`, `starts-with` and their like; numbers
and dates take comparisons. Accepting a fragment of SQL instead would make every other rule here
decoration. A `%` a person typed is a literal `%`: the wildcards are added to the value, not to the
pattern.

**A row is addressed by its whole primary key.** The key comes from the catalogue, not from a column
called `id` — a table whose key is two columns exists in this very project. Half a key would match a
set of rows and change all of them, so it is refused; a table with no key at all can be read and not
changed. Key columns cannot be edited either: the row is addressed by them.

**A changing request must carry `x-pg-interface: 1`.** This is the package's own protection against a
request sent by another site: a cross-site form cannot add a header, and a cross-site `fetch` that
adds one is stopped by a preflight this package never answers — it sends no CORS headers at all. It
is deliberately its own guard rather than the host application's: a mechanical check that reads tRPC
procedures cannot see this package, whatever it does.

**Row values never reach the log.** These databases hold password hashes and session identifiers. The
log gets table names and counts.

## What it does not do

Change the schema. No table is created, dropped or altered, and no column either: in this project the
schema belongs to each module's migrations, and an interface that added a column would be arguing with
them. Read the rows, fix a row, delete a row.

## Commands

```bash
pnpm --filter @grimcode/pg-interface build
pnpm --filter @grimcode/pg-interface test
```

The tests run without a database: `connect` is an option so a test can hand in a pool of its own.
What needs a real server — that the catalogue queries are valid SQL, that a filter with a quote in it
is data — is covered by the acceptance suite against a running application.
