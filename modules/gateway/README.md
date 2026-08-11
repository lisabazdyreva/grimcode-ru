# gateway

The entry for traffic. The composer mounts Gateway, and only Gateway, on the public listener, so
every request from outside reaches it before it reaches anything else.

It is not the entry of the *program* — that is `composition/`, which starts first and builds
everything — and it stays a module rather than becoming the composer. The composer has to know every
module; Gateway holds the access policy. Together they would be the widest permission in the
repository handed to the narrowest job.

It has no database and contains no product business logic.

## Routing

The path is never rewritten — a module receives exactly the address the browser asked for. That is
what makes the two kinds of target interchangeable: routing has always gone by path, and a module in
this process reads the path off the very same `Request`.

| Incoming path | Target | Gateway check |
| --- | --- | --- |
| `/admin/embed/service/:name/**` | admin surface of that module | session, admin role, grant on `:name` |
| `/admin/**` | `admin` | session and an admin role |
| `/service/:name/**` | module from the public allowlist | none — the module secures itself |
| `/app/**` | `app` | none — App verifies the user session itself |
| everything else | `site` | none — public |

`:name` is never turned into a target by itself. It is only ever looked up in the explicit allowlists in
[`src/registry.ts`](src/registry.ts):

- **public** — `auth`, `users`;
- **admin** — `auth`, `users`, `notifications`, `email`, `adminer`.

Adminer is deliberately absent from the public list. An unknown name has no entry, so nothing is
proxied and Admin is not even asked about it — the answer is 404.

`scripts/check-service-ids.mjs` reconciles these lists with `shared/src/vocabulary.ts` and the central Admin
shell, so a service can never be reachable here while being invisible in the shell.

## Admin authorization

Every `/admin/**` request — HTML, API and assets alike — passes the same check. There is no
separate public policy for admin assets.

The whole check is one internal Admin method, `admin.authorize`. Gateway computes nothing itself,
keeps no copy of the rights and caches no result, which is why a changed grant takes effect on the
very next request.

| Admin answer | Gateway |
| --- | --- |
| `allowed` | proxies and forwards the verified administrator context |
| `denied` | 403, regardless of the reason |
| `awaiting-first-user` | 403 explaining that nobody has registered yet |
| unreachable | **503**, fail-closed — an outage is never reported as "no rights" |

### The administrator context is a trust boundary

Before deciding anything, Gateway deletes every `x-template-admin-*` and `x-template-request-id`
header from the incoming request — on **all** routes, including public ones. It writes them again
only from a verified `allowed` result. A browser can therefore never forge an administrator
context, and a service can trust the headers precisely because only Gateway can reach it.

## Responses and encoding

The proxy runtime decodes compressed responses transparently, so Gateway asks upstream for
`accept-encoding: identity` and removes `content-encoding` and `content-length` from what it
forwards — those headers would otherwise no longer describe the body. Hop-by-hop headers are
dropped in both directions.

Upstream redirects are passed through untouched (`redirect: 'manual'`), because a service's own
redirect belongs to the browser. Adminer's very first response is exactly that: a redirect that
also sets its own session cookie.

## Environment

| Variable | Purpose |
| --- | --- |
| `PROJECT_SLUG` | Session cookie name Gateway reads to find the session token |
| `PUBLIC_SITE_URL` | External origin, used in the sign-in link of the 403 page |
| `SERVICE_URL_*` | Optional overrides of a module's base address — the way back out to a real service |

Gateway does not hold addresses any more: the composer builds every module and hands the whole set
over as `targets`. A target may be an application in this process or a URL, and Gateway does not
care which — Adminer is a URL today, and a module that has to be moved back out into a service of its
own becomes one without touching this package.

The process's listening port is fixed inside the image. Locally the published host port comes from
`GATEWAY_PORT` in `.env`; in production nothing is published at all.

## Commands

```bash
pnpm --filter @template/gateway test
```
