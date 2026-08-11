import { serveService } from '@template/shared';

import { compose } from './wiring.js';

/**
 * The entry point of the program.
 *
 * The entry of the *program* is this file; the entry for *traffic* is Gateway, the only application
 * mounted on the public listener. That is why the line below mounts Gateway alone: adding
 * `app.route('/', authApp)` here out of convenience would put the internal surfaces on the public
 * port and let the panel's own admin shadow the four embedded ones — no error, no failing build,
 * just a boundary that is gone.
 */
const { apps, logger } = await compose();

serveService(apps.gateway, 'gateway', logger);
