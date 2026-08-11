import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { adminInternalContract, ContractRouterClient } from '@template/contracts';
import {
  createLogger,
  createPool,
  createRpcClient,
  createServiceApp,
  internalServiceUrl,
  mountCsrfEndpoint,
  mountRpc,
  mountSpa,
  readAdminContext,
  runMigrations,
  serveService,
  waitForDatabase,
} from '@template/shared';

import { migrations } from './db/migrations.js';
import { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import { adminRouter, type IsActiveOwner } from './routers/admin.js';
import { internalRouter } from './routers/internal.js';
import { publicRouter } from './routers/public.js';

const logger = createLogger('auth');
const pool = createPool('auth');
const repo = new AuthRepository(pool);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

const app = createServiceApp('auth', logger);

/**
 * The one fact Auth needs from Admin, supplied here rather than reached for from the router.
 *
 * This file is the wiring: the only place that is allowed to know both sides. The router declares
 * `IsActiveOwner` and is handed an implementation, so the call between the two modules exists in
 * one direction only — as a dependency this file satisfies, not as a module importing a neighbour.
 */
const adminService = createRpcClient<ContractRouterClient<typeof adminInternalContract>>({
  url: `${internalServiceUrl('admin')}/internal/rpc`,
});

const isActiveOwner: IsActiveOwner = async (userId) =>
  (await adminService.isActiveOwner({ userId })).activeOwner;

/**
 * Three mounts, one per trust boundary.
 *
 * Gateway proxies `/service/auth/**` and `/admin/embed/service/auth/**` and never proxies
 * `/internal/**`, so the internal surface stays reachable only from the Docker network.
 */

mountRpc(app, '/service/auth/rpc', publicRouter, ({ request, resHeaders, hono }) => ({
  repo,
  notifier: new Notifier(hono.get('logger'), () => hono.get('requestId')),
  logger: hono.get('logger'),
  request,
  resHeaders,
}));

mountRpc(app, '/internal/rpc', internalRouter, () => ({ repo }));

mountRpc(app, '/admin/embed/service/auth/rpc', adminRouter, ({ request, hono }) => ({
  repo,
  notifier: new Notifier(hono.get('logger'), () => hono.get('requestId')),
  logger: hono.get('logger'),
  request,
  // Written by Gateway only after Admin allowed the request; a client can never forge it.
  admin: readAdminContext(request.headers),
  isActiveOwner,
}));

mountCsrfEndpoint(app, '/admin/embed/service/auth/csrf', 'auth');

mountSpa(app, {
  basePath: '/admin/embed/service/auth',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'auth', logger);
