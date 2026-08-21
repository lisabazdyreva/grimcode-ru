*[Documentation](README.md) → Deployment*

# Deployment

What a deployment supplies, what it must not, and what happens on the way up.

## What a person actually decides

Four things, and they are the four below the next heading: the **domain**, the **database**, a
**project slug** and an **address to send mail from**. Database passwords are no longer among them —
there are no per-module roles, so there is one account, and it comes with `DATABASE_URL`. The pieces a
deployment usually expects to configure are not among them either:

| | Where it comes from |
| --- | --- |
| The port | `PORT` if the platform sets one, `GATEWAY_PORT` from the environment file otherwise, 8080 if neither. |
| PostgreSQL | A managed resource, or a server on the same machine. Either way, reached through `DATABASE_URL`. |
| Per-module databases | `<PROJECT_SLUG>_<module>`, created by each module itself on its first request. |
| Restarts, environment, logs | One systemd unit — [`deploy/app.service`](../deploy/app.service). |

## What a deployment supplies

There is no production `.env` example to copy: the list lives here. None of these has a working
default — a value that is wrong in production is worse than a run that refuses to start, so the
program throws on a missing one and names it, before the port is open.

| Required | |
| --- | --- |
| `PROJECT_SLUG` | Names the databases. Changing it points every service at a different database. **At most 49 characters of `[a-z0-9_]`** — PostgreSQL truncates identifiers to 63 bytes silently, and `<slug>_notifications` adds fourteen. |
| `PUBLIC_SITE_URL` | The public origin as a visitor sees it. Links in email are built from it, and it decides whether the session cookie is marked `Secure`. |
| `DATABASE_URL` | The managed database. Every module connects through it, swapping in its own database name, and creates that database when it is missing — so the account needs **`CREATEDB`**. It does not need `CREATEROLE`: there are no per-module roles any more. Consequence worth naming: one account opens all five databases, so which module works where is enforced by the wiring and a check at startup, not by PostgreSQL. |
| `EMAIL_FROM_ADDRESS` | Who messages come from. |

| Optional | |
| --- | --- |
| `EMAIL_PROVIDER` | `log` records messages without sending them, which is the default. `unisender` sends through UniSender Go. |
| `EMAIL_FROM_NAME`, `UNISENDER_GO_API_KEY`, `UNISENDER_GO_API_URL` | The transport's own settings. |
| `AUTH_SESSION_TTL_SECONDS` | How long a session lasts. Thirty days by default. |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error`. `info` by default; anything below the level is not written at all. |
| `DATABASE_URL_ADMIN`, `_AUTH`, `_USERS`, `_NOTIFICATIONS`, `_EMAIL` | One module's database elsewhere — another server, or an account with other rights. A full override, taken exactly as written. |

## Deploying

Four steps, and the last one is the only one that interrupts anything:

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart grimcode
```

The unit file is [`deploy/app.service`](../deploy/app.service); it is copied to
`/etc/systemd/system/` once, with its paths and its user edited. What it takes over from the
container is written down there: restarting the process, handing it the environment file, and
collecting the logs — `journalctl -u grimcode -f`.

Node is the machine's now, not the image's. `engines` in the manifest says what the project expects
(22 or newer); nothing enforces it at runtime.

## What is exposed

The application listens on one port, and only that port. What terminates TLS and routes the domain to
it is outside this repository — a reverse proxy on the same machine, or the platform's own router.

The panel's database section has nothing behind it in any environment: the third-party console that
used to answer there has been removed, and this template's own interface is not written yet. Gateway
still checks the section — the owner gets a 503, anybody else the usual 403.

## What happens on start

One process.

1. **The composer** builds every module, hands each the connection string of its own database and
   mounts Gateway on the port. No database work happens here, and nothing waits for PostgreSQL: the
   process is listening in under a second.
2. **Each module prepares its own storage on the first request that needs it** — creates its database
   if it is missing, applies its versioned migrations, checks that the connection landed on the
   database it was meant to open, and keeps the pool for the life of the process. Email creates the
   seed templates that are missing at the same moment, leaving edited ones alone.

**What that trade means for a deploy.** There is no step that can stop it any more: a broken migration
is not a failed deployment, it is a 500 to the first person through the door, with the reason in the
logs of the module that refused (`module database unavailable`). Watch the logs of the first minutes,
not the exit code of a job. In return there is nothing to keep in step: one process, one restart, and
no ordering between steps to get wrong.

Then the first person to register becomes the owner of the admin panel — see
[administrator access](admin-access.md).

`GET /healthz` is what a platform can watch: `{"ok":true,"service":"gateway"}` and a 200, on the same
port as everything else, with no session needed. It checks nothing itself, and says less than it used
to: a module opens its database on the first request that needs it, so an answer here means the
process is up and Gateway is listening, not that PostgreSQL can be reached. The first request to a
module is what finds that out — and answers 500 with the reason in the log if it cannot.

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

## Rate limits

Auth counts failed sign-ins per address — ten in fifteen minutes, constants in the module rather than
settings, because a defence that can be configured can be weakened — and a successful sign-in
clears the count. Recovery mail is collapsed onto one message per identity per fifteen-minute
bucket, so asking for a reset over and over does not turn the form into a way to mail someone
repeatedly. Buckets are wall-clock, not a window since the last request: two requests either side of
a boundary are two messages, which is the price of not keeping state for it.

**The two are kept in different places, and only one of them doubles.** The sign-in counter lives in
the process's own memory: exact for the topology here — one process — and one full allowance per
extra copy of the application, so it stops being exact the moment a deployment runs more than one.
The mail dedupe does not: the bucketed key is what Auth sends to Notifications, which stores it
under a unique index, so a second copy of the application and a restart both change nothing.

The counter is also all a service can honestly do on its own: limits per client address need the real
client address, and only the proxy in front of Gateway has it. A deployment that expects hostile
traffic puts volumetric limits there — requests per address for `/service/*/rpc` and `/admin/**` —
and Auth's counter stays as the last line for one account under attack.

## Upgrading

Migrations are forward-only and versioned, and each module applies its own on the first request after
a deploy. A failed schema change therefore does not stop the deploy — it answers 500 until it is fixed,
which is the trade described in the start-up sequence above.

A rollback is therefore a matter for the change itself: a migration that dropped something cannot be
undone by checking out an older commit.
