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

import { NotificationsRepository } from './repository.js';
import { adminRouter, internalRouter } from './routers.js';

export { migrations } from './db/migrations.js';

export interface NotificationsDeps {
  logger: Logger;
  pool: Pool;
  /** Answers Email's internal surface: Notifications routes an event, Email renders and sends it. */
  callEmail: FetchLike;
}

export function createApp(deps: NotificationsDeps): ServiceApp {
  const repo = new NotificationsRepository(deps.pool);
  const app = createServiceApp('notifications', deps.logger);

  // Notifications has no public surface: only other modules emit events, over the internal path.
  mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
    repo,
    logger: hono.get('logger'),
    requestId: hono.get('requestId'),
    callEmail: deps.callEmail,
  }));

  mountRpc(app, '/admin/embed/service/notifications/rpc', adminRouter, ({ request }) => ({
    repo,
    admin: readAdminContext(request.headers),
  }));

  mountCsrfEndpoint(app, '/admin/embed/service/notifications/csrf', 'notifications');

  mountSpa(app, {
    basePath: '/admin/embed/service/notifications',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
