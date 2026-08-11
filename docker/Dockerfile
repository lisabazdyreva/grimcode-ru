# syntax=docker/dockerfile:1

# One image for the whole application.
#
# The modules are packages of one workspace and run in one process, so there is one build and one
# runtime image. `@template/composition` is the entry: it builds every module, wires them together
# and mounts Gateway on the port.
#
# The trade this makes is worth knowing. A change anywhere now invalidates the copy layer and runs
# `tsc` over every package and seven `vite build`s, where a per-service image rebuilt one. That is
# more work per rebuild, not less — which is why the fast local cycle is `pnpm dev` outside the
# container rather than this file.

ARG NODE_IMAGE=node:22-alpine

# --- Dependencies -------------------------------------------------------------
# Only the manifests are copied first, so the install layer is reused whenever sources change.
FROM ${NODE_IMAGE} AS deps
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json turbo.json ./
COPY composition/package.json ./composition/package.json
COPY contracts/package.json ./contracts/package.json
COPY shared/package.json ./shared/package.json
COPY modules/admin/package.json ./modules/admin/package.json
COPY modules/app/package.json ./modules/app/package.json
COPY modules/auth/package.json ./modules/auth/package.json
COPY modules/email/package.json ./modules/email/package.json
COPY modules/gateway/package.json ./modules/gateway/package.json
COPY modules/notifications/package.json ./modules/notifications/package.json
COPY modules/site/package.json ./modules/site/package.json
COPY modules/users/package.json ./modules/users/package.json

# The frozen lockfile is the repository's single lockfile; modules never carry their own.
RUN pnpm install --frozen-lockfile

# --- Build --------------------------------------------------------------------
FROM deps AS build

COPY composition ./composition
COPY contracts ./contracts
COPY shared ./shared
COPY modules ./modules

RUN pnpm --filter @template/composition... build

# Produces a self-contained directory with production dependencies only. For the composer that is
# the union of what all eight modules need at runtime — both Reacts, the mail renderer, the
# database driver — because they now share a process.
RUN pnpm --filter @template/composition deploy --prod /out/app

# --- Runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /out/app ./

USER node

# The entry of the program. Gateway is the entry for traffic, and the composer is what mounts it.
CMD ["node", "dist/index.js"]
