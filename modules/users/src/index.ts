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

import { resolveIdentity } from './auth-client.js';
import { UsersRepository } from './repository.js';
import { adminRouter, publicRouter } from './routers.js';

export { migrations } from './db/migrations.js';

export interface UsersDeps {
  logger: Logger;
  pool: Pool;
  /** Answers Auth's internal surface. Users owns no sessions and asks on every protected call. */
  callAuth: FetchLike;
}

export function createApp(deps: UsersDeps): ServiceApp {
  const repo = new UsersRepository(deps.pool);
  const app = createServiceApp('users', deps.logger);

  mountTrpc(app, '/service/users/rpc', publicRouter, async ({ request, resHeaders, hono }) => ({
    repo,
    request,
    resHeaders,
    identity: await resolveIdentity(request, hono.get('requestId'), deps.callAuth),
  }));

  mountTrpc(app, '/admin/embed/service/users/rpc', adminRouter, ({ request, resHeaders }) => ({
    repo,
    request,
    resHeaders,
    callAuth: deps.callAuth,
    admin: readAdminContext(request.headers),
  }));

  mountCsrfEndpoint(app, '/admin/embed/service/users/csrf', 'users');

  mountSpa(app, {
    basePath: '/admin/embed/service/users',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
