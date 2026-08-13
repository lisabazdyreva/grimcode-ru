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
about: `migrate` seeds the email templates for `email` alone. That is operational work of the same
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

- **the wiring has a cycle in it.** Admin asks Auth who a session belongs to; Auth asks Admin whether
  an identity is an active owner. `call(name)` resolves the neighbour at call time rather than at
  build time, which is what lets both be built at all;
- **the deadline is ours.** `AbortSignal` is not honoured by an in-process call, so `createTrpcClient`
  enforces the wait itself. It stops the caller waiting; it cannot stop the handler running.

A module may keep the function it is handed, and may not call it while it is being built. `apps` is
filled in one module at a time, and the neighbour a cycle points at is not there yet: Auth is built
before Admin, so calling `isActiveOwner` from inside `createApp` reads `undefined`. Nothing catches
that — the types are right, the boundaries are unbroken, and the error only says `undefined`.

## The list of secrets is kept by hand

`forgetSecrets` deletes each single-module secret from `process.env` once it has been handed out,
because one process means one environment and a neighbour's credentials read out of it would open a
database that is not theirs. Three of its four rules are shapes of a name — `DATABASE_URL`,
`DATABASE_URL_*`, `DB_PASSWORD_*` — and the fourth is one variable of one module,
`UNISENDER_GO_API_KEY`.

So a new secret has to be added there by hand, and nothing will remind you: no check reads that list,
and a forgotten name simply stays readable to every module in the process. It is the one line in the
wiring that needs maintaining when a module gains a credential of its own.

## Files

| File | What is in it |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Build everything, mount Gateway, listen |
| [`src/wiring.ts`](src/wiring.ts) | Pools, modules, the calls between them, the secrets removed afterwards — and `MIGRATIONS`, the one list of which modules own a database |
| [`src/bin/db-init.ts`](src/bin/db-init.ts) | Databases, roles and ownership |
| [`src/bin/migrate.ts`](src/bin/migrate.ts) | Migrations and the email seed templates |

`bin/db-init.ts` and `bin/migrate.ts` are the two jobs a deployment runs; `pnpm db-init` and
`pnpm migrate` are the same two on a machine.

## Commands

```bash
pnpm db-init
pnpm migrate
pnpm migrate auth   # one module instead of all five
pnpm --filter @template/composition build
```
