import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServiceApp, mountSpa, type Logger, type ServiceApp } from '@template/shared';

export interface AppDeps {
  logger: Logger;
}

/**
 * The user-facing application.
 *
 * It has no database of its own: identity and sessions come from Auth, the product profile from
 * Users, and every protected call is checked by the module that owns the data. The build directory
 * is resolved from this file rather than the working directory, which the composer chooses.
 */
export function createApp(deps: AppDeps): ServiceApp {
  const app = createServiceApp('app', deps.logger);

  mountSpa(app, {
    basePath: '/app',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
