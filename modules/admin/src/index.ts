import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountRpc,
  mountSpa,
  readAdminContext,
  type FetchLike,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';

import { AdminRepository } from './repository.js';
import { adminRouter, createAuthClient, internalRouter } from './routers.js';

export { migrations } from './db/migrations.js';

export interface AdminDeps {
  logger: Logger;
  pool: Pool;
  /** Answers Auth's internal surface: who the session belongs to, and who the first identity is. */
  callAuth: FetchLike;
}

export function createApp(deps: AdminDeps): ServiceApp {
  const repo = new AdminRepository(deps.pool);
  const app = createServiceApp('admin', deps.logger);

  /**
   * The single authorization method Gateway calls on every `/admin/**` request. It is mounted on
   * the internal path only, which Gateway never routes to, so no browser can reach it.
   */
  mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
    repo,
    auth: createAuthClient(hono.get('requestId'), deps.callAuth),
    logger: hono.get('logger'),
  }));

  mountRpc(app, '/admin/rpc', adminRouter, ({ request, resHeaders, hono }) => ({
    repo,
    auth: createAuthClient(hono.get('requestId'), deps.callAuth),
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
