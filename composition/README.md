# composition

The entry of the program, and the only package that knows every module.

It reads the environment, opens the database pools, builds each module, hands out what each one
needs, mounts Gateway on the port and listens. That is the whole of it.

## Nothing here is a decision

Only the order of calls. No routing, no policy, no defaults, no "if this is missing then that".

This is the one package with permission to import every other — `check-boundaries.mjs` grants it
explicitly — and that permission is affordable exactly while the rule above holds. The day a
decision moves in here, this becomes the place where decisions are made with the widest access in
the repository, and both the reason for a separate package and the point of the boundaries are gone.

Where a decision belongs instead: routing in `gateway`, product rules in the module that owns the
data, anything shared and mechanical in `shared`.

## Two entry points, and they are not the same thing

- The **entry of the program** is `src/index.ts`. It starts first and builds everything.
- The **entry for traffic** is Gateway. It is the only application mounted on the public listener,
  so every request from outside reaches it before it reaches anything else.

The Compose service is called `server` — the whole process. The module inside it that traffic enters
through is called `gateway`.

Mounting anything else on that listener out of convenience — `app.route('/', authApp)` — would put
the internal surfaces on the public port and let the panel's own admin shadow the four embedded
ones. No error, no failing build, just a boundary that is gone.

## The calls between modules

Modules talk through their contracts, exactly as they did over the network, and the composer is what
makes that cheap: it hands each module's client the neighbour's own `app.fetch`, so the request is
answered by a call instead of a socket. The URL in the client still matters — a `Request` is built
from it — but nobody dials it.

Two things follow, and both are easy to miss:

- **the wiring has a cycle in it.** Admin asks Auth who a session belongs to; Auth asks Admin whether
  an identity is an active owner. `call(name)` resolves the neighbour at call time rather than at
  build time, which is what lets both be built at all;
- **the deadline is ours.** `AbortSignal` is not honoured by an in-process call, so `createRpcClient`
  enforces the wait itself. It stops the caller waiting; it cannot stop the handler running.

## Files

| | |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Build everything, mount Gateway, listen |
| [`src/wiring.ts`](src/wiring.ts) | Pools, modules, the calls between them, and the secrets removed afterwards |
| [`src/bin/db-init.ts`](src/bin/db-init.ts) | Databases, roles and ownership. Runs to completion before anything else |
| [`src/bin/migrate.ts`](src/bin/migrate.ts) | Migrations and the email seed templates. Runs to completion before the application |
| [`src/bin/module.ts`](src/bin/module.ts) | One module on its own port, for looking at it in isolation |

`bin/db-init.ts` and `bin/migrate.ts` are the two jobs a deployment runs; `pnpm db-init` and
`pnpm migrate` are the same two on a machine.

`bin/module.ts` lives here rather than inside a module's own package on purpose. A bin inside a
module would have to read the environment and open a pool — the two things a module may not do — so
it would need an exception carved out of both rules in the very file that breaks them, or it would
grow into a second composer beside this one. Nothing checks that it still works at runtime; what
keeps it honest is that it compiles with everything else.

## Commands

```bash
pnpm --filter @template/composition build
```
