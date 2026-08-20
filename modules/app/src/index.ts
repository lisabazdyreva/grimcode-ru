import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, createServiceApp, mountSpa, type ServiceApp } from '@template/shared';

/**
 * The user-facing application.
 *
 * It has no database of its own: identity and sessions come from Auth, the product profile from
 * Users, and every protected call is checked by the module that owns the data. The build directory
 * is resolved from this file rather than the working directory, which the composer chooses.
 *
 * It takes nothing: it needs no state, no neighbour and no settings, and its logger is its own like
 * every module's. The composer calls it with no arguments at all.
 */
export function createApp(): ServiceApp {
  const logger = createLogger('app');
  const app = createServiceApp('app', logger);

  mountSpa(app, {
    basePath: '/app',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
