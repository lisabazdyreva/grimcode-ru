import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  RPC_TIMEOUT_MS,
  withDeadlineOn,
  type Logger,
  type Pool,
} from '@template/shared';

import type { NotificationsInternalCaller } from '@template/notifications/contract';

import { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import { adminRouter, type IsActiveOwner } from './routers/admin.js';
import { createInternalCallerFactory } from './routers/internal.js';
import { publicRouter } from './routers/public.js';

export { migrations } from './db/migrations.js';
export type { IsActiveOwner } from './routers/admin.js';

export interface AuthDeps {
  logger: Logger;
  pool: Pool;
  /** Reaches Notifications' internal surface; a caller per request, so the id travels with it. */
  callNotifications: (call: { requestId: string }) => NotificationsInternalCaller;
  /**
   * Whether an identity is an active owner of the panel — Admin's fact, and required: a missing
   * implementation is a compile error rather than a rule that silently stops running.
   */
  isActiveOwner: IsActiveOwner;
}

/**
 * Both shapes a composer needs — an application for what Gateway routes here, a caller for the
 * neighbours — from one factory, so the repository is built once.
 *
 * Three mounts, one per trust boundary. Gateway routes `/service/auth/**` and
 * `/admin/embed/service/auth/**` here and never routes `/internal/**` anywhere, so the internal
 * surface stays reachable only from inside the process.
 */
export function createModule(deps: AuthDeps) {
  const repo = new AuthRepository(deps.pool);

  /*
   * The request the call belongs to is taken and not used: these procedures write no line of their
   * own, so there is no logger here for the id to reach. The argument is the shape every module's
   * caller has, and what the first line written here would need.
   */
  const internalCaller = (_call: { requestId: string }) =>
    withDeadlineOn(createInternalCallerFactory({ repo }), 'auth', RPC_TIMEOUT_MS);

  const app = createServiceApp('auth', deps.logger);

  const notifier = (logger: Logger, requestIdOf: () => string) =>
    new Notifier(logger, requestIdOf, deps.callNotifications);

  mountTrpc(app, '/service/auth/rpc', publicRouter, ({ request, resHeaders, hono }) => ({
    repo,
    notifier: notifier(hono.get('logger'), () => hono.get('requestId')),
    logger: hono.get('logger'),
    request,
    resHeaders,
  }));

  mountTrpc(app, '/admin/embed/service/auth/rpc', adminRouter, ({ request, resHeaders, hono }) => ({
    repo,
    notifier: notifier(hono.get('logger'), () => hono.get('requestId')),
    logger: hono.get('logger'),
    request,
    resHeaders,
    // Written by Gateway only after Admin allowed the request; a client can never forge it.
    admin: readAdminContext(request.headers),
    isActiveOwner: deps.isActiveOwner,
  }));

  mountCsrfEndpoint(app, '/admin/embed/service/auth/csrf', 'auth');

  mountSpa(app, {
    basePath: '/admin/embed/service/auth',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return { app, internalCaller };
}

export type AuthInternalCaller = ReturnType<ReturnType<typeof createModule>['internalCaller']>;
