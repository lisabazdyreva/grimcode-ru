# composition

The entry of the program, and the only package that knows every module.

It reads the environment, opens the database pools, builds each module, hands out what each one
needs, mounts Gateway on the port and listens. That is the whole of it.

## Nothing in the wiring is a decision

`compose()` is the order of calls and nothing else: no routing, no policy, no defaults, no "if this
is missing then that".

It does refuse to start in one place, and a refusal is not a decision — there is no second branch to
take. After opening the pools it asks each one `SELECT current_database()` and stops unless the answer
is the database that module was meant to get. A role cannot open the wrong database, but a
`DATABASE_URL_<MODULE>` override bypasses the role, and an override is what a deployment edits by
hand — without this the first sign would be data in the wrong place.

This is the one package with permission to import every other — `workspace-rules.mjs` grants it
explicitly, and both boundary checks read that grant from there — and the permission is affordable
exactly while the rule above holds. The day a decision moves in here, this becomes the place where
decisions are made with the widest access in the repository, and both the reason for a separate
package and the point of the boundaries are gone.

Where a decision belongs instead: routing in `gateway`, product rules in the module that owns the
data, anything shared and mechanical in `shared`.

The two `bin/` jobs are the deliberate exception. Setting databases up is operational work, so they do
branch: a console account gets `CONNECT` only if a deployment created one, ownership moves only the
first time a role appears, an unknown module name is refused. The rule above is about the wiring —
that is what carries the widest permission.

One of those branches names a module rather than a state, and it is the one worth being explicit
about: Email seeds its own templates when its database is fresh. That is operational work of the same
kind — it needs the schema just applied, it is idempotent, and it renders every template through
`@maily-to/render`, which is why it belongs to a command that runs once rather than to every start.

## Only Gateway is mounted

Mounting anything else on that listener out of convenience — `app.route('/', authApp)` — would put
the internal surfaces on the public port and let the panel's own admin shadow the four embedded
ones. No error, no failing build, just a boundary that is gone.

Why the entry of the program and the entry for traffic are different things, and why the Compose
service `server` is not the module `gateway`, is in
[docs/architecture.md](../docs/architecture.md).

## The calls between modules

Modules talk through their published surfaces, exactly as they did over the network. The composer is
what keeps that from costing a socket: it hands each module the neighbour's own `app.fetch`, and the
module builds its client around it, so a call answers where a socket used to. The URL still matters —
a `Request` is built from it — but nobody dials it.

Two things follow, and both are easy to miss:

- **the deadline is ours.** `AbortSignal` is not honoured by an in-process call, so `createTrpcClient`
  enforces the wait itself. It stops the caller waiting; it cannot stop the handler running;
- **a module may keep the function it is handed, and may not call it while it is being built.** The map
  of applications is built in one expression, so a neighbour named by `call(name)` may not exist yet
  when the closure is made. It is looked up when a request arrives, which is what makes that safe —
  and calling it from inside `createApp` would read `undefined` instead, with the types right, the
  boundaries unbroken, and an error that says only `undefined`.

The calls run in one direction: Admin, Users and Gateway ask Auth, Auth asks Notifications,
Notifications asks Email. Nothing asks back, so the applications can be built in dependency order.

## The environment is read here and left in place

Everything a module gets out of the environment is read in `compose()` and handed over as a value: the
mail settings, the session lifetime, one connection string per module. A module reads nothing itself,
which the lint rules and `check-boundaries` enforce.

What used to be here as well was deletion: every credential removed from `process.env` once handed out,
so that one process did not leave a neighbour's password readable. That went, deliberately. It bought
less than it looked like — the connection string lives on `c.env` for the life of the process either
way, and `/proc/<pid>/environ` keeps the startup snapshot regardless — and it cost a reader that
remembered every name it read, plus a list of variables it must never be given because they are read
after `compose()` returns or again on every request.

So `DATABASE_URL` and the mail key stay readable through `process.env` for anything inside the process,
dependencies included. That is the standard exposure of a Node application, now accepted here too.

## Files

| File | What is in it |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The whole package: what each module is given, the calls between them, `DATABASE_MODULES`, and — behind a guard at the bottom — starting the program |

One file, importable and runnable: the listener at the bottom starts only when this file is the program,
so the tests and the acceptance suite can import `compose` without opening a port. There is nothing else
to run — databases, migrations and the email seed templates are each module's own work, done on the first
request that needs them.

## Commands

```bash
pnpm --filter @template/composition build
```

There is nothing else: the databases and their migrations are each module's own work, done on the first
request that needs them.
