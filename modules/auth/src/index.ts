import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  type FetchLike,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';

import { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import { adminRouter, type IsActiveOwner } from './routers/admin.js';
import { internalRouter } from './routers/internal.js';
import { publicRouter } from './routers/public.js';

export { migrations } from './db/migrations.js';
export type { IsActiveOwner } from './routers/admin.js';

export interface AuthDeps {
  logger: Logger;
  pool: Pool;
  /** Answers Notifications' internal surface, where Auth hands off the events it emits. */
  callNotifications: FetchLike;
  /**
   * Whether an identity is an active owner of the panel — Admin's fact, and required: a missing
   * implementation is a compile error rather than a rule that silently stops running.
   */
  isActiveOwner: IsActiveOwner;
}

/**
 * Three mounts, one per trust boundary.
 *
 * Gateway routes `/service/auth/**` and `/admin/embed/service/auth/**` here and never routes
 * `/internal/**` anywhere, so the internal surface stays reachable only from inside the process.
 */
export function createApp(deps: AuthDeps): ServiceApp {
  const repo = new AuthRepository(deps.pool);
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

  mountTrpc(app, '/internal/rpc', internalRouter, ({ request, resHeaders }) => ({
    repo,
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

  return app;
}
