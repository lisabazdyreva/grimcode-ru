# Documentation

A working product with its boring parts already done. This is what it is made of and why it is
made that way.

## Start here

| | |
| --- | --- |
| [Architecture](architecture.md) | The modules, what each owns, and why they are split like that |
| [The admin panel](admin-panel.md) | What is inside it, how it is composed, how to extend it |
| [Administrator access](admin-access.md) | Roles, grants, the first owner |
| [Local development](local-development.md) | Running it, worktrees, the checks |
| [Deployment](deployment.md) | What a deployment supplies, and what it must not |

Each module has a README beside its code, describing what only that module knows:
[gateway](../modules/gateway/README.md), [site](../modules/site/README.md),
[app](../modules/app/README.md), [admin](../modules/admin/README.md),
[auth](../modules/auth/README.md), [users](../modules/users/README.md),
[notifications](../modules/notifications/README.md), [email](../modules/email/README.md).

Four more READMEs sit outside `modules/`: the [composer](../composition/README.md), which builds them
all and wires them together; [shared](../shared/README.md), the toolbox every module may use and where
adding a procedure is explained; the [acceptance tests](../tests/README.md), which describe what is
verified against a running stack; and the [database browser](../docker/adminer/README.md), a container
rather than a package, whose README covers the wrapper around the one third-party application the
panel embeds.

## What this template decides for you

A template is only useful where it has taken a position. These are the positions, each with the
reason, so a project can disagree with one on purpose rather than by accident.

**One way in.** Gateway is the only application on the public listener: locally the process publishes
one port, in production none at all — the platform routes the domain to the container's internal port.
Nothing else is reachable from outside in either case — a module that could be reached directly would
make Gateway's checks optional.

**Modules, in one process.** Eight of them, each its own package, and a database of its own for the
five that store anything, talking to each other through contracts. They ran as eight containers
before and can again: the point of the contracts is that where a module runs is not what decides
what it may know. What one process costs is isolation of failure, and that is the price this
template chose to pay.

**Each module owns its data, and cannot reach anyone else's.** Not by agreement — by a role that has
no `CONNECT` on a neighbour's database. Every other boundary here is about code, and no check that
reads code can read a query.

**Identity and profile are different things.** Auth owns how someone signs in; Users owns who they
are inside the product. A product changes its profile fields constantly and its sign-in almost
never — joining them means every profile change touches the thing that guards accounts.

**Being an administrator is a separate record.** Not a flag on an account. Granting admin access
does not create a user and removing it does not touch one.

**The panel is composed, not merged.** Each module's admin is its own build, embedded in the shell
over a small `postMessage` protocol. The shell never imports their code, so a module can change its
admin without rebuilding the panel.

**Nothing is decided by the interface.** Hiding a menu entry is presentation; the server refuses the
same request either way, and the tests ask over HTTP through Gateway rather than by calling a router —
the two exceptions speak to PostgreSQL, because the refusal they are about never becomes a response.

**Email is stored, not re-rendered.** Publishing produces the HTML and text; delivery fills in the
values that are only known per recipient and sends that, without ever calling the renderer again. A
library upgrade cannot change a message someone already approved.

**One language.** Several are a real feature, but which language to send in depends on what a
product knows about a person — a guess here would be unpicked by every project.

**Small on purpose.** The profile is a display name. The event list is five auth events. Where the
template could only have guessed, it stops and leaves the decision where it belongs.
