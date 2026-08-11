import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountRpc,
  mountSpa,
  readAdminContext,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';

import { EmailRepository } from './repository.js';
import { renderMessage } from './render.js';
import { adminRouter, internalRouter } from './routers.js';
import { createTransport } from './transport.js';

export { migrations } from './db/migrations.js';

export interface EmailDeps {
  logger: Logger;
  pool: Pool;
}

/**
 * Creates the seed templates, in the editor's own format and already published, so the auth flows
 * work on a fresh installation. Existing templates are never overwritten, so running it twice
 * changes nothing.
 *
 * A separate export rather than part of `createApp` because it is data, not routing, and because it
 * renders every template through `@maily-to/render`. It belongs to the `migrate` command, where it
 * stops running on every restart of the process.
 */
export async function seedTemplates(deps: EmailDeps): Promise<number> {
  const repo = new EmailRepository(deps.pool);

  const seeded = await repo.ensureSeedTemplates((document, subject) =>
    renderMessage(document, subject).then(({ html, text }) => ({ html, text })),
  );
  if (seeded > 0) deps.logger.info('seed templates created', { created: seeded });

  return seeded;
}

export function createApp(deps: EmailDeps): ServiceApp {
  const repo = new EmailRepository(deps.pool);
  const transport = createTransport(deps.logger);
  const app = createServiceApp('email', deps.logger);

  mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
    repo,
    transport,
    logger: hono.get('logger'),
  }));

  mountRpc(app, '/admin/embed/service/email/rpc', adminRouter, ({ request, hono }) => ({
    repo,
    transport,
    logger: hono.get('logger'),
    request,
    admin: readAdminContext(request.headers),
  }));

  mountCsrfEndpoint(app, '/admin/embed/service/email/csrf', 'email');

  // The editor lives in this module's own build and loads only on the editor route; it is never
  // part of the central Admin bundle or of runtime delivery.
  mountSpa(app, {
    basePath: '/admin/embed/service/email',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
