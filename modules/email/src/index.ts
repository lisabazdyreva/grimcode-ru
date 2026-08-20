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

import type { EmailEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { EmailRepository } from './repository.js';
import { adminRouter, createInternalCallerFactory } from './routers.js';
import { createTransport, type Transport } from './transport.js';

export type { EmailEnv } from './env.js';
export type { MailSettings } from './transport.js';

/**
 * Both shapes a composer needs — an application for what Gateway routes here, a caller for the
 * neighbour — from one factory, so the pool and the transport are opened once between them.
 *
 * Takes nothing: this module calls no neighbour, and its database and mail settings arrive on
 * `c.env`. The caller is handed the same environment by the composer, because a direct call has no
 * request to read it from.
 */
export function createModule() {
  const logger = createLogger('email');

  // The pool on the first request that needs it: `c.env` exists inside a request and nowhere else.
  const database = createDatabase(logger);
  const repository = async (env: EmailEnv) => new EmailRepository(await database(env));

  // The transport likewise, from `c.env` on the first request and kept: which provider sends the mail
  // is not a per-message decision. Synchronous, so one line remembers it.
  let built: Transport | undefined;
  const transport = (env: EmailEnv) => (built ??= createTransport(env.mail, logger));

  const internalCaller = (env: EmailEnv, call: { requestId: string }) =>
    withDeadlineOn(
      createInternalCallerFactory(async () => ({
        repo: await repository(env),
        transport: transport(env),
        logger: logger.child({ requestId: call.requestId }),
      })),
      'email',
      RPC_TIMEOUT_MS,
    );

  const app = createServiceApp<EmailEnv>('email', logger);

  mountTrpc(
    app,
    '/admin/embed/service/email/rpc',
    adminRouter,
    async ({ request, resHeaders, hono }) => ({
      repo: await repository(hono.env),
      transport: transport(hono.env),
      logger: hono.get('logger'),
      request,
      resHeaders,
      admin: readAdminContext(request.headers),
    }),
  );

  mountCsrfEndpoint(app, '/admin/embed/service/email/csrf', 'email');

  // The editor lives in this module's own build and loads only on the editor route; it is never
  // part of the central Admin bundle or of runtime delivery.
  mountSpa(app, {
    basePath: '/admin/embed/service/email',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return { app, internalCaller };
}

export type EmailInternalCaller = ReturnType<ReturnType<typeof createModule>['internalCaller']>;
