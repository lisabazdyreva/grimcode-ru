import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';

import type { AuthInternalCaller } from '@template/auth/contract';

import { AdminRepository } from './repository.js';
import { adminRouter, internalRouter } from './routers.js';

export { migrations } from './db/migrations.js';

export interface AdminDeps {
  logger: Logger;
  pool: Pool;
  /**
   * Reaches Auth's internal surface: who the session belongs to, and who the first identity is.
   * A caller per request, so the id travels with it.
   */
  callAuth: (call: { requestId: string }) => AuthInternalCaller;
}

export function createApp(deps: AdminDeps): ServiceApp {
  const repo = new AdminRepository(deps.pool);
  const app = createServiceApp('admin', deps.logger);

  /**
   * The single authorization method Gateway calls on every `/admin/**` request. It is mounted on
   * the internal path only, which Gateway never routes to, so no browser can reach it.
   */
  mountTrpc(app, '/internal/rpc', internalRouter, ({ request, resHeaders, hono }) => ({
    repo,
    auth: deps.callAuth({ requestId: hono.get('requestId') }),
    logger: hono.get('logger'),
    request,
    resHeaders,
  }));

  mountTrpc(app, '/admin/rpc', adminRouter, ({ request, resHeaders, hono }) => ({
    repo,
    auth: deps.callAuth({ requestId: hono.get('requestId') }),
    request,
    resHeaders,
    requestId: hono.get('requestId'),
    admin: readAdminContext(request.headers),
  }));

  mountCsrfEndpoint(app, '/admin/csrf', 'panel');

  // The central Admin shell. Gateway has already verified the session and the admin role for every
  // request that reaches these assets.
  mountSpa(app, {
    basePath: '/admin',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
