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

## How many rows a table has

The exact number, unless the table is too large to count. A list of tables must not cost a full scan of
a large table, so the planner's `reltuples` is read first — it is free — and it decides one thing only:
whether counting is cheap. Above 10 000 rows the estimate is what the list shows; at or below that the
rows are counted for real, and so are the tables the planner has no estimate for at all (`reltuples` is
**-1** until something analyses a table, which is most tables on a young installation).

Three signs, because these are three different statements:

| On screen | What it says |
| --- | --- |
| `42` | the count |
| `~25002` | the planner's estimate, which can be off in either direction |
| `>10000` | counting stopped at the limit, so there are at least this many |

Two things this got wrong before, in that order. Reading `-1` as zero told a person a table with rows
in it was empty. Then, with that fixed, the estimate was used whenever it existed — so a table
autovacuum had been past showed `~3` beside a plain `5`, and the tilde marked the wrong thing: not
"this number is big" but "this table has been analysed". The `>` is from the same round: a count that
stopped at the limit is a floor, and showing it as `~10000` read as "roughly ten thousand" when the
table held 25 000.

## The screen

`web/` is a Vue 3 application with element-plus, built by vite into `web/dist` and served by this
package itself — the server reads the files, because a package that depends on nothing cannot borrow a
static-file helper either. Two details are load-bearing:

- **`base: './'`** in the vite config. The host decides where this is mounted, so asset URLs are
  relative to the page; an absolute base would bake one project's path into the package;
- **the theme comes from the host** over `postMessage`, message type `template.admin.theme`, written
  to `data-theme` on the root element and mirrored to element-plus's `dark` class. The type and the
  convention are copied rather than imported — see `web/src/theme.ts`, which says what would break if
  one side renamed it.

What the screen shows: the databases it was handed, the tables of one of them with the key and how many
rows each holds, and a page of rows. A cell shows one line of its value and **opens the whole of it when
clicked** — a hash, a uuid or a json document does not fit a line, and a tooltip cannot be selected or
copied. json opens indented, with the stored form one button away. Per column: sort, filter, hide. Filters offer the conditions the server
said that column takes, joined with "and" or "or". A row opens in a dialog, where the key is read-only
and everything else is editable; only what actually changed is sent.

**A filter is asked only once it can be answered.** A condition appears with nothing typed in it, and
an empty value means "not finished", not "match the empty string" — sending it anyway made PostgreSQL
answer `invalid input syntax for type uuid: ""` for the act of adding a row to a form. The count on the
button is of filters actually being asked, so a half-filled one is visibly not one of them. Conditions
that ask about presence (`is-empty`, `is-not-empty`) need no value and are asked at once.

**A value the column cannot hold answers 400, not 500.** PostgreSQL error classes 22 and 23 — a value
the type refuses, a constraint the row breaks — are answers to what the request carried, so they read as
a refusal; the message is shown, because it names the type and not the row. Anything else is this side
failing and stays a 500.

**Named views are deliberately absent.** The interface this one is modelled on stores them on its
server; ours has nowhere to store them, because it creates no table of its own — so the current view
lives in the URL hash instead, which is what made named views worth having: a link somebody can send.

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
