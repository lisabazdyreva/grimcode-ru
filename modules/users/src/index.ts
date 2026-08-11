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

  mountRpc(app, '/service/users/rpc', publicRouter, async ({ request, hono }) => ({
    repo,
    identity: await resolveIdentity(request, hono.get('requestId'), deps.callAuth),
  }));

  mountRpc(app, '/admin/embed/service/users/rpc', adminRouter, ({ request }) => ({
    repo,
    request,
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
