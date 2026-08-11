*[Documentation](README.md) → Deployment*

# Deployment

What a deployment supplies, what it must not, and what happens on the way up.

## What a person actually decides

Two things: the **domain** and the **database**. Everything else is fixed in the images.

| | Where it comes from |
| --- | --- |
| The internal port | Fixed in the image and Compose. Nobody sets it. |
| The public port | There is none. The platform routes the domain to the container's internal port. |
| PostgreSQL | A managed resource, reached through `DATABASE_URL`. |
| Per-module databases and roles | Created on first deploy as `<PROJECT_SLUG>_<module>`. |

## What a deployment supplies

There is no production `.env` example to copy: the list lives here, and `docker/compose.yaml` is
what enforces it. None of these has a working default — a value that is wrong in production is
worse than a run that refuses to start, so Compose fails on a missing one and names it.

| Required | |
| --- | --- |
| `PROJECT_SLUG` | Names the Compose project and the databases. Changing it points every service at a different database. |
| `PUBLIC_SITE_URL` | The public origin as a visitor sees it. Links in email are built from it, and it decides whether the session cookie is marked `Secure`. |
| `DATABASE_URL` | The managed database, as the role that owns the server. `db-init` uses it to create the module roles and hand them ownership, so it needs `CREATE ROLE` and the ability to transfer ownership of objects to those roles — a superuser, or a member of them. |
| `EMAIL_FROM_ADDRESS` | Who messages come from. |
| `DB_PASSWORD_ADMIN`, `_AUTH`, `_USERS`, `_NOTIFICATIONS`, `_EMAIL` | One password per module. Each module connects as its own role `<PROJECT_SLUG>_<module>` with its own password and can open no other database. Five separate secrets, and this is real added work for whoever deploys — there is no default and no fallback to the credentials in `DATABASE_URL`. |

| Optional | |
| --- | --- |
| `EMAIL_PROVIDER` | `log` records messages without sending them, which is the default. `unisender` sends through UniSender Go. |
| `EMAIL_FROM_NAME`, `UNISENDER_GO_API_KEY`, `UNISENDER_GO_API_URL` | The transport's own settings. |
| `AUTH_SESSION_TTL_SECONDS` | How long a session lasts. Thirty days by default. |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error`. `info` by default; anything below the level is not written at all. |
| `AUTH_LOGIN_ATTEMPT_LIMIT`, `AUTH_LOGIN_ATTEMPT_WINDOW_SECONDS` | Failed sign-ins allowed per address, and the window they are counted in. Ten in fifteen minutes by default. |
| `DATABASE_URL_ADMIN`, `_AUTH`, `_USERS`, `_NOTIFICATIONS`, `_EMAIL` | One module's database elsewhere — another server, or an account with other rights. A full override, taken exactly as written. |
| `ADMINER_SERVER`, `ADMINER_USERNAME`, `ADMINER_PASSWORD` | The database console's own connection, which is how it gets fewer rights than the application has. `db-init` grants `ADMINER_USERNAME` the right to **connect** to each database — without it the console cannot log in at all, since `PUBLIC` no longer may. It grants no right to **read**: how much data the console sees is decided by whoever created that account, and granting it here would silently undo what a deployment narrowed on purpose. Empty means the console reuses `DATABASE_URL` and sees everything. |

```bash
docker compose --env-file .env.production -f docker/compose.yaml up -d --build
```

## What is exposed

Only the application, and only to the platform. Nothing publishes a host port in production —
`scripts/check-compose.mjs` refuses a configuration where something does.

Adminer is in production, on the internal network, reachable exclusively through Gateway's
owner-only route. It never gets a host port in any environment.

## What happens on start

Three containers, in order, and the first two run to completion before the third starts.

1. **`db-init`** creates any missing module database and role, hands each role ownership of its
   database and of the objects inside it, and revokes `CONNECT` from `PUBLIC` so that a module
   presented with a neighbour's database is refused while connecting. Safe on every later deploy: it
   only adds what is absent and re-states what is already true.
2. **`migrate`** applies each module's versioned migrations, in order, recording what it applied, and
   creates the seed email templates that are missing while leaving edited ones alone. A failure here
   stops the deploy with a non-zero exit code naming the module — the application never starts on a
   half-migrated database.
3. **`server`** builds every module, hands each its pool, deletes the single-module secrets from its
   own environment, and mounts Gateway on the port.

Then the first person to register becomes the owner of the admin panel — see
[administrator access](admin-access.md).

## Email will not send until it is told to

`EMAIL_PROVIDER` defaults to `log` even in production: messages are rendered, recorded in the
delivery log, and go nowhere. That is deliberate — a half-configured transport should not mail real
people.

Set `EMAIL_PROVIDER=unisender` with `UNISENDER_GO_API_KEY` to send through UniSender Go, the one
ready production transport. Another provider is an ordinary code change behind a small interface,
not a configuration matrix.

## Sessions and cookies

The session cookie is `HttpOnly` and `SameSite=Lax`, and is marked `Secure` when `PUBLIC_SITE_URL`
is `https`. That follows the origin rather than an environment name, because the same production
images also run locally over plain http, where a `Secure` cookie would never come back.

`AUTH_SESSION_TTL_SECONDS` is thirty days by default.

## Rate limits

Auth counts failed sign-ins per address — `AUTH_LOGIN_ATTEMPT_LIMIT` attempts inside
`AUTH_LOGIN_ATTEMPT_WINDOW_SECONDS`, ten in fifteen minutes by default — and a successful sign-in
clears the count. Recovery mail is deduplicated per identity for fifteen minutes, so asking for a
reset over and over does not turn the form into a way to mail someone repeatedly.

Both are counted in the process's own memory. That is exact for the topology here — one process —
and it doubles the allowance for every extra copy of the application, so it stops being exact the
moment a deployment runs more than one. It is also all a service can
honestly do on its own: limits per client address need the real client address, and only the proxy
in front of Gateway has it. A deployment that expects hostile traffic puts volumetric limits there —
requests per address for `/service/*/rpc` and `/admin/**` — and Auth's counter stays as the last
line for one account under attack.

## Building images

One Dockerfile, one image, three uses: the application and the two jobs above. It contains the
production dependency closure of the composer — `pnpm deploy --prod` — which is the union of what all
eight modules need at runtime, and no build tooling.

## Upgrading

Migrations are forward-only and versioned. `migrate` runs as its own step before the new application
starts, so a schema that fails to move stops the deploy rather than the application.

A rollback is a matter for the change itself: a migration that dropped something cannot be undone by
starting an older image.
