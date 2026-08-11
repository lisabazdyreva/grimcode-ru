# shared

Common technical utilities every module is allowed to use.

Business logic and per-module repositories never live here — those belong to the owning module.
A module may import its own folder, `contracts/`, `shared/` and external packages, and nothing
else.

## Runtime modules

| Module | Purpose |
| --- | --- |
| `env.ts` | Typed environment access, project slug, per-module database URLs and roles, cookie names |
| `service-urls.ts` | The port the process listens on, and the addresses a module's client is built from |
| `logger.ts` | JSON-line logger with request-scoped child loggers |
| `crypto.ts` | Ids, single-use tokens, scrypt password hashing, constant-time comparison |
| `http/cookies.ts` | Cookie parsing and serialization, including the expired logout cookie |
| `http/admin-context.ts` | The verified administrator context headers and their strip/apply/read helpers |
| `http/csrf.ts` | Double-submit CSRF token issuing and validation |
| `http/service-app.ts` | Shared Hono app: request ids, access log, health endpoint, fail-closed 503 |
| `db/admin-pool.ts` | `createAdminPool`, reachable only as `@template/shared/admin` — the owner's connection, used by `db-init` and nothing else |
| `rpc.ts` | What a call to a neighbour needs whichever library carries it: `FetchLike`, the deadline, `ServiceUnavailableError` |
| `trpc/mount.ts` | Mounting a tRPC router on a path prefix, merging `set-cookie` from procedures |
| `trpc/contract.ts` | `fromContract` — procedures with the contract's schemas baked in — and `contractCoverage` |
| `trpc/builders.ts` | The context every procedure has, and the two guards admin surfaces are built from |
| `trpc/client.ts` | Typed tRPC client factory for one module calling another |
| `db/pool.ts` | One PostgreSQL pool per module database, transactions, startup wait |
| `db/migrator.ts` | Versioned migrations with recorded versions, checksums and advisory locks |
| `theme.ts` | The same-origin `postMessage` protocol between Admin shell and service iframes |

### Admin context is a trust boundary

`ADMIN_CONTEXT_HEADERS` are the headers Gateway writes after Admin allowed a request. Gateway
deletes every one of them from the incoming request first, so a browser can never forge them. A
service treats a missing or malformed context as a denial.

### Migrations

`runMigrations` records each applied version with a checksum. A fresh database is built from
version 1 upwards, an existing database only receives missing versions, and running the same set
again changes nothing. Editing an already released migration is an error — add a new version.

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
