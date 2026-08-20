import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmailInternalCaller } from '@template/email/contract';
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

import { NotificationsRepository } from './repository.js';
import { adminRouter, createInternalCallerFactory } from './routers.js';

export { migrations } from './db/migrations.js';

export interface NotificationsDeps {
  logger: Logger;
  pool: Pool;
  /**
   * Reaches Email's internal surface: Notifications routes an event, Email renders and sends it.
   *
   * A caller per request rather than one for the process — the request id is what ties the lines
   * Email writes to the request that caused them.
   */
  callEmail: (call: { requestId: string }) => EmailInternalCaller;
}

/**
 * Both shapes a composer needs — an application for the admin surface, a caller for the neighbour
 * that emits events — from one factory, so the repository is built once. The caller takes the
 * request it belongs to: one per process would stamp every later event with the first id.
 */
export function createModule(deps: NotificationsDeps) {
  const repo = new NotificationsRepository(deps.pool);

  const internalCaller = (call: { requestId: string }) =>
    withDeadlineOn(
      createInternalCallerFactory({
        repo,
        logger: deps.logger.child({ requestId: call.requestId }),
        email: deps.callEmail(call),
      }),
      'notifications',
      RPC_TIMEOUT_MS,
    );

  const app = createServiceApp('notifications', deps.logger);

  mountTrpc(
    app,
    '/admin/embed/service/notifications/rpc',
    adminRouter,
    ({ request, resHeaders }) => ({
      repo,
      request,
      resHeaders,
      admin: readAdminContext(request.headers),
    }),
  );

  mountCsrfEndpoint(app, '/admin/embed/service/notifications/csrf', 'notifications');

  mountSpa(app, {
    basePath: '/admin/embed/service/notifications',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return { app, internalCaller };
}

export type NotificationsInternalCaller = ReturnType<
  ReturnType<typeof createModule>['internalCaller']
>;
