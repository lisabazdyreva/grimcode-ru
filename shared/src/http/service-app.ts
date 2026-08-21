import { Hono } from 'hono';

import { newId } from '../crypto.js';
import type { Logger } from '../logger.js';
import type { InternalServiceName } from '../service-names.js';
import { REQUEST_ID_HEADER } from './admin-context.js';

export interface ServiceAppVariables {
  requestId: string;
  logger: Logger;
}

/**
 * The environment a module is given, per module and per request.
 *
 * Hono calls this slot `Bindings`, and its point here is that the type is the module's own: a module
 * typed with its own shape cannot name a neighbour's variable, because the name does not exist on
 * `c.env`. The values arrive as the second argument to `app.fetch`, which the composer supplies —
 * so a module also never holds anything but its own, at runtime and not only in the types.
 *
 * A module with nothing to be given says so with `{}`, which is the default.
 *
 * The only route by which anything read from the environment reaches a module — which is why a module's
 * pool is built on the first request and not while the application is assembled: `c.env` exists inside a
 * request and nowhere else. Built once and remembered, not per request.
 */
export type ServiceEnv = object;

export type ServiceApp<TEnv extends ServiceEnv = object> = Hono<{
  Bindings: TEnv;
  Variables: ServiceAppVariables;
}>;

/**
 * Hono application shared by every Node service: request id propagation, access logging and a
 * health endpoint. It contains no product logic and no routing policy — Gateway owns routing.
 */
export function createServiceApp<TEnv extends ServiceEnv = object>(
  service: InternalServiceName,
  logger: Logger,
): ServiceApp<TEnv> {
  const app = new Hono<{ Bindings: TEnv; Variables: ServiceAppVariables }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? newId();
    const requestLogger = logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', requestLogger);
    c.header(REQUEST_ID_HEADER, requestId);

    const startedAt = Date.now();
    await next();
    requestLogger.info('request', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
  });

  app.get('/healthz', (c) => c.json({ ok: true, service }));

  return app;
}

