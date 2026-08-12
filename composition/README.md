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

## Two entry points, and they are not the same thing

- The **entry of the program** is `src/index.ts`. It starts first and builds everything.
- The **entry for traffic** is Gateway, in `modules/gateway`. It is the only application mounted on
  the public listener, so every request from outside reaches it before it reaches anything else.

The Compose service is called `server` — the whole process. The module inside it that traffic enters
through is called `gateway`.

Mounting anything else on that listener out of convenience — `app.route('/', authApp)` — would put
the internal surfaces on the public port and let the panel's own admin shadow the four embedded
ones. No error, no failing build, just a boundary that is gone.

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
