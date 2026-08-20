import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLogger,
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  RPC_TIMEOUT_MS,
  withDeadlineOn,
} from '@template/shared';

import type { AuthInternalCaller } from '@template/auth/contract';

import type { AdminEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { AdminRepository } from './repository.js';
import { adminRouter, createInternalCallerFactory, internalRouter } from './routers.js';

export type { AdminEnv } from './env.js';

export interface AdminDeps {
  /**
   * Reaches Auth's internal surface: who the session belongs to, and who the first identity is.
   * A caller per request, so the id travels with it.
   */
  callAuth: (call: { requestId: string }) => AuthInternalCaller;
}

/**
 * Both shapes a composer needs — an application for what Gateway routes here, a caller for Gateway's
 * authorization check — from one factory, so the pool is opened once between them. The caller takes
 * the environment as well as the request: a direct call has no `c.env` to read.
 */
export function createModule(deps: AdminDeps) {
  const logger = createLogger('admin');
  const app = createServiceApp<AdminEnv>('admin', logger);

  // The pool on the first request that needs it: `c.env` exists inside a request and nowhere else.
  const database = createDatabase(logger);
  const repository = async (env: AdminEnv) => new AdminRepository(await database(env));

  const internalCaller = (env: AdminEnv, call: { requestId: string }) =>
    withDeadlineOn(
      createInternalCallerFactory(async () => ({
        repo: await repository(env),
        auth: deps.callAuth(call),
        logger: logger.child({ requestId: call.requestId }),
      })),
      'admin',
      RPC_TIMEOUT_MS,
    );

  /**
   * The single authorization method Gateway calls on every `/admin/**` request. It is mounted on
   * the internal path only, which Gateway never routes to, so no browser can reach it.
   */
  mountTrpc(app, '/internal/rpc', internalRouter, async ({ request, resHeaders, hono }) => ({
    repo: await repository(hono.env),
    auth: deps.callAuth({ requestId: hono.get('requestId') }),
    logger: hono.get('logger'),
    request,
    resHeaders,
  }));

  mountTrpc(app, '/admin/rpc', adminRouter, async ({ request, resHeaders, hono }) => ({
    repo: await repository(hono.env),
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

  return { app, internalCaller };
}

export type AdminInternalCaller = ReturnType<ReturnType<typeof createModule>['internalCaller']>;
