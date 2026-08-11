*[Documentation](README.md) → Local development*

# Local development

## Getting it running

```bash
pnpm install
cp .env.example .env
pnpm start
```

`.env` is the only local configuration and nothing generates it: the values shipped in
`.env.example` run as they are. `PROJECT_SLUG` is worth setting before the first run — it names the
Compose project, the cookies and the databases.

Ports come from one range, `PORT_RANGE_START..PORT_RANGE_END`. Its first port is the main checkout's
and nothing else may take it; `GATEWAY_PORT` names it and `PUBLIC_SITE_URL` follows, which is what
ends up in email links and what decides whether the session cookie is marked `Secure`.

The stack is then at `PUBLIC_SITE_URL`. `/` is the site, `/app/` the application, `/admin` the
panel. The first account you register becomes the owner of the panel.

If Docker refuses to create the network because its address pools are exhausted — which happens on a
machine running many projects and worktrees at once — `pnpm network:allocate` gives this copy a free
subnet of its own and never touches anyone else's.

## Everyday commands

| | |
| --- | --- |
| `pnpm start` / `pnpm stop` | Start and stop the stack |
| `pnpm db-init` / `pnpm migrate` | Create the databases and roles; apply the migrations |
| `pnpm logs server` | Follow the application |
| `pnpm check` | Lint, types, unit tests, production build, dependencies, boundaries, service ids, Compose |
| `pnpm test:acceptance` | The HTTP checks, against the running stack |
| `pnpm test:browser` | The Chromium checks, against the running stack |

`pnpm check` is what has to be green. It runs from a clean checkout with the single lockfile and
needs no running stack.

## The fast cycle: running the application on the machine

`pnpm start` rebuilds the image, and one image now holds every module, so a one-line change costs a
full rebuild — around forty seconds. The second mode skips Docker for the application entirely:

```bash
node scripts/compose.mjs up -d postgres adminer
pnpm db-init && pnpm migrate
pnpm dev
```

The first two are the same commands the deployment runs as jobs before the application starts, and
they are needed here for the same reason: the application no longer migrates anything on start-up.
Running them again is harmless — both only ever add what is missing.

`pnpm dev` builds what changed and runs the application directly, on `GATEWAY_PORT` — the same
address as the container it replaces, so nothing else has to be told about it. PostgreSQL is reached
through `LOCAL_POSTGRES_HOST` from `.env`: the host `postgres` exists only inside the Compose
network, and the published port differs per worktree.

Four things this mode does not give you:

- **`/admin/database` does not work.** Adminer answers at `adminer:8080`, a name that exists only
  inside the Compose network, and it may never be given a host port — that is a documented rule
  `check-compose.mjs` enforces. Everything else in the panel works.
- **Error bodies carry a stack.** `NODE_ENV` is not `production` outside the container, so an RPC
  failure answers with more detail than a deployment would.
- **It is your machine's Node.** The image pins one; here you get whatever `node -v` says, which is
  the point of the speed and also the reason a green `pnpm dev` is not a green deployment.
- **Migrations are yours to run.** `pnpm migrate` after a schema change, before `pnpm dev` — nothing
  applies them behind you any more.

## Reaching it from another machine

Nothing to configure: the gateway is published on every interface, so the stack answers on the
machine's address from the host of a virtual machine or a phone on the same network. The database is
not — it stays on loopback, and there is no setting that moves it.

The one consequence worth knowing: until an account is registered, whoever registers first becomes
the owner of the panel. On a network you do not control, register immediately after starting.

## Worktrees

A worktree is a separate checkout on another branch, with its own Compose project, its own
PostgreSQL container, its own volume and its own ports. Worktrees never share a database: one branch
changing a schema would break the other.

```bash
git worktree add ../project-feature -b feature
cd ../project-feature
pnpm install
pnpm bootstrap:worktree
```

It finds the main checkout through git rather than a path written down anywhere, carries its `.env`
over, replaces what must differ, and copies the local module databases across with a logical dump
and restore — so the new branch starts with the data you were already working with.

Ports come out of `PORT_RANGE_START..PORT_RANGE_END`, never the first one — that belongs to the main
checkout, along with whatever ports its `.env` names, and both are held back rather than probed: the
main stack is often stopped while a branch is being set up, and a port that merely happens to be
free right now is not free to take. `PUBLIC_SITE_URL` follows the picked port and keeps the main
checkout's host, so a stack reachable from another machine stays reachable from it.

It also clears away what deleted worktrees left on the machine. A checkout that is gone still has its
Docker network holding address space nothing will ever use again — that is what exhausts Docker's
pools and makes the next stack fail to start. Recognised narrowly: the Compose project label, this
template's `<slug>_internal` name, no container attached, and a slug no live checkout uses. Volumes
are listed rather than removed, because a volume is the database of a branch someone may want back;
the command to remove them is printed.

Running it again **keeps** databases the worktree already has. Replacing them is explicit:

```bash
pnpm bootstrap:worktree --refresh-databases
```

A day's work in a worktree cannot be wiped by re-running it out of habit.

This is the one place a script still writes `.env` for you, and the reason is that a worktree's
values are derived rather than chosen: the main checkout's file is the starting point, and what
must differ — the slug, the ports, the database credentials — is replaced.

## The database

The panel's database browser is at `/admin/database`, owner-only, through Gateway. It is the real
Adminer, themed to match the panel around it; it has no host port in any environment.

`psql` works too — PostgreSQL is published on loopback for exactly that:

```bash
node scripts/compose.mjs exec postgres psql -U template -d "${PROJECT_SLUG}_auth"
```

Each module connects as a role of its own — `<PROJECT_SLUG>_<module>`, with the password from
`DB_PASSWORD_<MODULE>` — and owns its database and everything in it. `PUBLIC` has no `CONNECT`, so a
module presented with a neighbour's database name is refused while connecting, before any statement
runs. That is the only layer here that catches a query written against a neighbour's table: to every
other check in this repository, SQL is a string.

The role above is the owner of the server, from `DATABASE_URL`, which is what `db-init` uses and
what `psql` is convenient with.

## The checks, and what each is for

| Script | Refuses |
| --- | --- |
| `check-dependencies.mjs` | A manifest declaring a neighbouring service, or a package that reaches outside the process — the database driver lives in `shared` and nowhere else; an `.npmrc` setting that would hoist every package into reach |
| `check-boundaries.mjs` | A module importing another module, type-only imports included; a database pool opened outside the wiring; a module reading the environment |
| `check-service-ids.mjs` | A service known to Gateway but invisible in the Admin shell, or the reverse; Adminer being public or grantable |
| `check-compose.mjs` | Anything but the application published locally; anything at all published in production; a PostgreSQL container in production |
| `check-scripts.mjs` | A script named after a pnpm command — `pnpm up` would run pnpm's dependency update instead of starting the project |

They exist because each protects a rule that is easy to break by accident and hard to notice.

## Adding a module

1. The module under `modules/`, with its routers split by trust boundary — public, internal, admin —
   and a `src/contract.ts` re-exporting their **types** for whoever calls it.
2. The same package exporting `createApp(deps)` and — if it stores anything — its
   `migrations`, plus an entry in the composer's `MIGRATIONS` list, which is what gives it a pool, a
   database and a role.
3. Its id in `ADMIN_SERVICE_IDS` in [`shared/src/vocabulary.ts`](../shared/src/vocabulary.ts) and —
   only if it should be reachable without a session — in Gateway's public allowlist.
4. Its entry in the Admin shell's [`services.ts`](../modules/admin/web/src/services.ts).
5. Its password variable `DB_PASSWORD_<MODULE>` in `.env.example` and in the Compose environment
   anchor. Nothing else in `docker/compose.yaml` changes: a module is not a container any more.

`check-service-ids.mjs` will tell you if you missed one of the three places ids live.

For a module's admin interface, see [the admin panel](admin-panel.md).
