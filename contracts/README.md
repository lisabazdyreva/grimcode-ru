# contracts

Zod runtime schemas for every inter-module call of the template, paired as `{ input, output }`.

This package holds **no** server implementation, SQL or provider secrets, and it depends on nothing
but `zod` — a contract that imported an RPC library would tie every module to that library's
lifetime, which is the mistake this template has already had to undo once.

A contract is what a module publishes about itself. Everything that crosses a boundary goes through
one — including now that the modules share a process, where the transport is the neighbour's own
application rather than the network.

The pairs are not decoration: `fromContract` in `shared` builds each procedure with the contract's
own `.input()` and `.output()` baked in, and `contractCoverage` refuses to compile a router that
implements the wrong set. Together they are what replaced the library-level contract checking the
template used before.

## Layout

| File | Contents |
| --- | --- |
| `src/common.ts` | Service ids, admin roles, pagination, the verified admin context schema |
| `src/auth.ts` | Identity, sessions, public auth flows, internal lookups, Auth service admin |
| `src/admin.ts` | Administrator registry, the single `authorize` method Gateway calls, audit |
| `src/users.ts` | Product profile |
| `src/notifications.ts` | The closed set of typed events and their template routing |
| `src/email.ts` | Templates, versions, publish, preview, test send and the delivery log |

## Three surfaces per module

Every service contract is split by trust boundary, and each part is mounted on its own path:

- `public` — reachable through Gateway as `/service/<name>/rpc`. Gateway performs no authorization
  here; securing these endpoints is the service's own responsibility.
- `admin` — reachable as `/admin/embed/service/<name>/rpc` only after Gateway verified the session, the
  admin role and the grant on that service.
- `internal` — mounted on `/internal/rpc`, which Gateway never proxies, so it stays reachable only
  from inside the process: Gateway routes nothing to it.

## Service ids

`SERVICE_IDS`, `ADMIN_SERVICE_IDS` and `ASSIGNABLE_SERVICE_IDS` are the canonical lists.
`ASSIGNABLE_SERVICE_IDS` deliberately excludes `adminer`: Adminer is always owner-only and can
never be granted to a regular administrator.

Gateway and the central Admin shell keep their **own** explicit declarations rather than deriving
ids at runtime. `scripts/check-service-ids.mjs` and the contract tests reconcile all three.

## Commands

```bash
pnpm --filter @template/contracts build
```

```bash
pnpm --filter @template/contracts test
```
