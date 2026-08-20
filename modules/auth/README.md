# auth

Minimal user identity, sign-in methods, sessions, email verification, account recovery and the
security flows around them.

Auth does **not** own the product profile (that is Users) or administrator rights (that is Admin).
Even though its main table is called `identities`, these are identity users, not product profiles.

## Data

Auth owns the database `<PROJECT_SLUG>_auth` and no other — it connects as the role of the same
name, which has no right to connect to anyone else’s. Versioned migrations live in
[`src/db/migrations.ts`](src/db/migrations.ts) and are applied by the `migrate` command, not on
start.

| Table | Contents |
| --- | --- |
| `identities` | email, password hash, verification and blocking state, registration `sequence` |
| `sessions` | one row per session, storing only the **hash** of the session token |
| `auth_tokens` | single-use time-limited tokens for verification, recovery and email change |
| `auth_audit` | every security-relevant action, including who performed it |

Secret tokens are never stored in readable form. Nobody — including an owner — can read a
recovery token out of the database.

`identities.sequence` gives registration a deterministic order. Admin relies on it to decide who
the very first registered user is when it bootstraps the first owner.

## Surfaces

| Mount | Reachable as | Who may call it |
| --- | --- | --- |
| `/service/auth/rpc` | through Gateway, no admin check | anyone — Auth secures these itself |
| `/admin/embed/service/auth/rpc` | through Gateway's admin route | administrators with a grant on Auth |
| `/internal/rpc` | never routed by Gateway; in-process only | other modules |

### What a neighbour may see of this module

A tRPC client is typed from the server's router, so the type has to cross the module boundary. It
crosses through one named door: `@template/auth/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the three router types and the four shapes
neighbours and browsers name by hand — `Identity`, `AdminIdentity`, `SessionSummary`,
`AuthAuditEntry` — and nothing else, while the bare `@template/auth` resolves to `createModule` and
`migrations` and nothing besides.

Auth has more callers than any other module — Admin, Users in two separate places, and the
application's own browser bundle — and holds the password hashes, the session rows and the one-time
tokens. All three live behind `repository.ts`, which no specifier reaches; what crosses the boundary
is the shape of the questions and nothing else.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure declares and the
`satisfies` line beside each router, which refuses to compile when the router holds a name the
surface is not allowed to hold — see [shared/README.md](../../shared/README.md) for how a procedure is added.

The admin **mutations** here check the CSRF token under the scope `'auth'`, not `'panel'`: every admin
surface issues its own cookie, so a token minted for the shell is refused here on purpose. The reads —
`listIdentities`, `getIdentity`, `listAudit` — are built on the other builder and check the verified
administrator context alone.
The public surface has no CSRF token at all and is not meant to — it is the application's own
surface, and the session cookie's `SameSite=Lax` is what guards it.

### Public flows

`register`, `login`, `logout`, `currentSession`, `listOwnSessions`, `revokeOwnSessions`,
`requestPasswordReset`, `resetPassword`, `changePassword`, `verifyEmail`, `resendOwnVerification`,
`requestEmailChange`, `confirmEmailChange`.

Security properties worth keeping when the template is extended:

- **Recovery does not reveal whether an address exists.** `requestPasswordReset` always answers
  `ok`, and `requestEmailChange` answers `ok` for an address already taken.
- **`register` is the deliberate exception.** It does say that an address is taken, because a form
  that silently pretends to succeed leaves someone who forgot they had an account with no idea what
  happened. Sign-in and recovery are the flows that must not disclose, and they do not; a project
  that needs registration not to either answers `ok` and mails the existing account a "someone tried
  to register" message instead of answering the form.
- **Login is not an existence oracle.** When no identity matches, a fixed dummy hash is still
  verified so both branches take comparable time.
- **Guessing one password is not free.** Failed sign-ins are counted per address and refused past the
  limit, with the same message everyone else gets. Per address rather than per client on purpose:
  the real client address is known only to the proxy in front of Gateway.
- **Links work exactly once.** Tokens are consumed in a single atomic statement, so a double click
  cannot use one twice, and issuing a new token of the same purpose invalidates the previous one.
- **Changing a password ends every session**, including one an attacker may be holding.
- **Logout is a server-side operation.** The session row is invalidated first and the HttpOnly
  cookie is cleared afterwards. Deleting the cookie alone would leave a usable session behind.
- Public procedures are JSON-only RPC calls on a `SameSite=Lax` cookie, so a cross-site form
  cannot invoke them.

### Internal surface

`resolveSession`, `revokeSessionByToken`, `getFirstIdentity`, `getIdentitiesByIds`,
`searchIdentities`, `getIdentityByEmail`. Admin depends on these to resolve the current user, to
sign one out of the panel and to bootstrap the first owner; Users reads a page of addresses through
`getIdentitiesByIds`. A blocked identity resolves to no session at all, even if its session row has
not expired.

`revokeSessionByToken` ends one session and answers with nothing but an acknowledgement: the caller
owns the response the browser sees, so the caller clears the cookie — with `expiredSessionCookie`
from `shared`, which is the same cookie the public `logout` sends.

### Service admin

Search and list identities with verification state, blocking state and active session count, plus:

- send the ordinary one-time recovery link;
- resend the verification link of an unverified address;
- revoke all sessions of a user;
- **owner only** — block or unblock sign-in;
- read this module's own audit log, on a screen of its own.

An administrator never sets or sees a password or a recovery token: recovery uses exactly the same
time-limited flow through Notifications and Email as a user-initiated request. Blocking
immediately revokes sessions and outstanding auth tokens. An owner cannot block their own
identity, so the action can never remove the last working owner session.

Nor can anyone block *another* active owner: blocking takes away every session, and Admin's own
last-owner rule counts owners by its `enabled` flag and would not see it, so two owners could be
reduced to none — one blocked here, the other stripped there. Whether an identity is an active
owner is Admin's fact, and this service does not reach for it: the router declares what it needs
as `IsActiveOwner` and [`src/index.ts`](src/index.ts) hands it an implementation. The dependency is
required, never optional — a missing one is a compile error rather than a rule that quietly stops
running.

Every admin mutation requires both the Gateway-verified administrator context and a valid CSRF
token, is written to the Auth audit, and takes effect from the next request. Identity operations
are never moved into Users.

## Outgoing calls

Auth owns no email templates and no delivery. It reports typed events to Notifications, which
routes them to Email. It sends no locale with them: the recipient's language is a product preference
this template does not have, and mail ships in one language. A product that adds preferences reads the
language here and puts it in the event.

A failed hand-off to Notifications never fails a security flow; it is logged instead.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Auth uses `<PROJECT_SLUG>_auth` on that server |
| `PROJECT_SLUG` | Database and cookie naming |
| `PUBLIC_SITE_URL` | Origin of verification and recovery links, and what decides `Secure` on the session cookie |
| `AUTH_SESSION_TTL_SECONDS` | Session lifetime, 30 days by default |
| `AUTH_LOGIN_ATTEMPT_LIMIT` | Failed sign-ins allowed per address inside one window, 10 by default |
| `AUTH_LOGIN_ATTEMPT_WINDOW_SECONDS` | Length of that window, 15 minutes by default |
| `SERVICE_URL_NOTIFICATIONS` | Notifications' address, used to build the request Auth's client sends |

`Secure` follows that origin and **not** `NODE_ENV`, which this module never reads: the local stack
runs the very same production images over plain http, and a `Secure` cookie would never come back.

## Commands

```bash
pnpm --filter @template/auth test
```
