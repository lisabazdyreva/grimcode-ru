# notifications

Accepts typed events from services and routes them to Email.

Notifications stores no email templates and never reads another service's database. It is a
routing layer with a memory, not a mail service.

## Closed set of events

Only the event types declared in `contracts/src/notifications.ts` are accepted. The contract is a
discriminated union, so an unknown type is rejected by validation before it can reach storage.

The template ships the base auth events needed for registration, email verification, account
recovery and email change:

| Event | Email template |
| --- | --- |
| `auth.user.registered` | `auth-welcome` |
| `auth.email.verification_requested` | `auth-verify-email` |
| `auth.password.reset_requested` | `auth-password-reset` |
| `auth.email.change_requested` | `auth-confirm-email-change` |
| `auth.email.changed` | `auth-email-changed` |

A product adds its own events by extending the contract and this map — not by accepting free-form
payloads.

## Protection against repeated processing

Every `emit` carries a caller-supplied `dedupeKey`. The unique index on `events.dedupe_key` is what
actually prevents a repeated delivery from being routed twice: the second call reports the stored
event and does nothing else. Email deduplicates on its own side as well, so even a retried routing
cannot send the same message twice.

## Failures stay visible

If Email cannot be reached, the event is kept with status `failed` and the error message. It shows
up in the service admin instead of disappearing into a log line.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| `/internal/rpc` | never routed by Gateway; in-process only | other modules emitting events |
| `/admin/embed/service/notifications/rpc` | through Gateway's admin route | administrators granted Notifications |

Notifications has **no public surface**: it is deliberately absent from Gateway's public
allowlist, so no browser can emit an event.

### What Auth may see of this module

A tRPC client is typed from the server's router, so the type has to cross the module boundary. It
crosses through one named door and no other: `@template/notifications/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the two router types and nothing else, while
`@template/notifications` still resolves to `createApp` alone. The repository and the routing to
Email are reachable by no specifier at all.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure is built with and
the `contractCoverage` line beside each router, which refuses to compile when the router and the
contract disagree.

The admin surface issues a CSRF cookie like every other, and no call currently carries a token —
because nothing on it changes anything. An event is a record of what happened, and a log that can
be edited is not a record. The browser client no longer keeps a list of which procedures are
mutations; the link reads the operation's own type, so the day a mutation is added here the token
travels with it without anyone remembering to add a name to a list.

## Data

Database `<PROJECT_SLUG>_notifications`, single `events` table, opened as the role of the same
name. Migrations are in [`src/db/migrations.ts`](src/db/migrations.ts) and are applied by the
`migrate` command, not on start.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Notifications uses `<PROJECT_SLUG>_notifications` |
| `PROJECT_SLUG` | Database naming |

## Commands

```bash
pnpm --filter @template/notifications test
```
