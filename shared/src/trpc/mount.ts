import type { AnyTRPCRouter } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import type { Context as HonoContext } from 'hono';

import type { ServiceApp, ServiceAppVariables } from '../http/service-app.js';
import type { RpcContext } from './builders.js';

export interface TrpcRequestContext {
  request: Request;
  resHeaders: Headers;
  hono: HonoContext<{ Variables: ServiceAppVariables }>;
}

/**
 * Mounts a tRPC router on an exact path prefix.
 *
 * Each module keeps its surfaces on separate mounts, so the trust boundary is visible in the routing
 * table itself: `/service/<name>/rpc` is public, `/admin/embed/service/<name>/rpc` needs the admin
 * grant, and Gateway routes nothing at all to `/internal/rpc`.
 *
 * **`resHeaders` is merged by hand.** tRPC has no notion of a response header from inside a
 * procedure; the context carries a `Headers` and this merges it into the answer. Miss it and signing
 * in stops setting the session cookie — with no error anywhere, because the procedure succeeded.
 *
 * **`allowMethodOverride` lets a query arrive as POST.** Without it a query sent by POST answers
 * 405, and staying on POST keeps request bodies out of URLs — off the length limit, and out of the
 * caches a GET invites, since tRPC sets no `Cache-Control` of its own.
 */
export function mountTrpc<TContext extends RpcContext>(
  app: ServiceApp,
  prefix: `/${string}`,
  router: AnyTRPCRouter,
  createContext: (ctx: TrpcRequestContext) => TContext | Promise<TContext>,
): void {
  app.use(`${prefix}/*`, async (c) => {
    const resHeaders = new Headers();

    const response = await fetchRequestHandler({
      endpoint: prefix,
      req: c.req.raw,
      router,
      allowMethodOverride: true,
      createContext: () =>
        createContext({
          request: c.req.raw,
          resHeaders,
          hono: c as HonoContext<{ Variables: ServiceAppVariables }>,
        }),
    });

    if (resHeaders.entries().next().done === true) return response;

    const headers = new Headers(response.headers);
    resHeaders.forEach((value, key) => headers.append(key, value));
    return new Response(response.body, { status: response.status, headers });
  });
}
