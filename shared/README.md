# shared

Common technical utilities every module is allowed to use.

Business logic and per-module repositories never live here — those belong to the owning module.
A module may import its own folder, `shared/`, external packages and a neighbour's declared
`@template/<name>/contract`, and nothing else.

## Runtime modules

| Module | Purpose |
| --- | --- |
| `env.ts` | Typed environment access, project slug, per-module database URLs and roles, cookie names |
| `service-urls.ts` | The port the process listens on, and the addresses a module's client is built from |
| `logger.ts` | JSON-line logger with request-scoped child loggers |
| `crypto.ts` | Ids, single-use tokens, scrypt password hashing, constant-time comparison |
| `rate-limit.ts` | Fixed-window attempt counter, in memory on purpose — one account's password, not volumetric limits |
| `http/cookies.ts` | Cookie parsing and serialization, including the expired logout cookie |
| `http/admin-context.ts` | The verified administrator context headers and their strip/apply/read helpers |
| `http/csrf.ts` | Double-submit CSRF token issuing and validation |
| `http/service-app.ts` | Shared Hono app: request ids, access log, health endpoint, fail-closed 503 |
| `http/spa.ts` | Serving a built SPA with deep-link fallback, and the endpoint that issues its CSRF token |
| `db/admin-pool.ts` | `createAdminPool`, reachable only as `@template/shared/admin` — the owner's connection, used by `db-init` and nothing else |
| `rpc.ts` | What a call to a neighbour needs whichever library carries it: `FetchLike`, the deadline, `ServiceUnavailableError` |
| `trpc/mount.ts` | Mounting a tRPC router on a path prefix, merging `set-cookie` from procedures |
| `trpc/builders.ts` | The context every procedure has, and the two guards admin surfaces are built from |
| `trpc/client.ts` | Typed tRPC client factory for one module calling another |
| `db/pool.ts` | One PostgreSQL pool per module database, transactions, startup wait |
| `db/migrator.ts` | Versioned migrations with recorded versions, checksums and advisory locks |
| `theme.ts` | The same-origin `postMessage` protocol between Admin shell and service iframes |
| `vocabulary.ts` | The words the whole template shares: schema primitives, service ids, admin roles, the verified admin context |

### Admin context is a trust boundary

`ADMIN_CONTEXT_HEADERS` are the headers Gateway writes after Admin allowed a request. Gateway
deletes every one of them from the incoming request first, so a browser can never forge them. A
service treats a missing or malformed context as a denial.

### Migrations

`runMigrations` records each applied version with a checksum. A fresh database is built from
version 1 upwards, an existing database only receives missing versions, and running the same set
again changes nothing. Editing an already released migration is an error — add a new version.

## Adding a procedure

Two files, and the second step is the one that is easy to skip.

1. **Write the procedure in the module's router**, schemas and all:

   ```ts
   revokeSession: adminMutation
     .input(z.object({ sessionId: idSchema }))
     .output(z.object({ ok: z.literal(true) }))
     .mutation(async ({ input, ctx }) => { … }),
   ```

   A shape used by more than one procedure goes in the module's own `schemas.ts`; a shape a
   neighbour or a browser needs is named there too and re-exported from `src/contract.ts` as a
   **type** — that file compiles to `export {}` and a Zod object is a value.

2. **Add the name to the router's list**, the `satisfies` line at the closing brace:

   ```ts
   type AdminName = 'listIdentities' | 'getIdentity' | 'revokeSession';
   ```

   Forget it and the build fails, naming the procedure. That is the point of the list: it is what
   stops an admin procedure from being written into a public router, where anyone could call it.

### Two things here are not the tRPC from the documentation

**`.output()` is written on every procedure.** The tRPC docs call output validation optional —
"validating outputs is not always as important as defining inputs, since tRPC gives you automatic
type-safety by inferring the return type of your procedures" — and list not returning more data than
necessary as one reason to do it anyway. In this template that reason applies to all of them: every
procedure hands data from a database across a module boundary. Without the schema, whatever the
resolver returns is what ships, and TypeScript will not stop it — excess property checks apply to
object literals, not to the row you read from a repository.

**Each router is pinned to a list of names.** Stock tRPC has no such thing, because it has no
contract to be complete against. The list is a plain type and `satisfies` is a plain keyword; what
it buys is that a procedure cannot land on the wrong surface unnoticed.

Both are deliberate, and both cost a line. If a check ever refuses your router, it is one of these
two — not a bug.

## No shared UI

There is no shared stylesheet and no shared component. Each service admin vendors its own shadcn
source and its own palette, and Adminer keeps a stylesheet of its own — the same values written out
in three places on purpose, so one service restyling itself cannot restyle its neighbours.

What is shared is the *convention*: `light` and `dark` are explicit through `[data-theme]`, and
`system` is the absence of the attribute, which is exactly what the shell's theme bridge sends.

The kit exists for server-rendered or third-party admin surfaces only. React admins use the real
checked-in shadcn source components from the central Admin and share nothing but the tokens.

## Commands

```bash
pnpm --filter @template/shared build
```

```bash
pnpm --filter @template/shared test
```
